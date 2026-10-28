/** Keyless assembled sidebar search: cold history, CJK substrings, and message highlights. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, readPersistedEvents, seedSession, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/sidebar-content-search/ui.expected.md', import.meta.url))
const RECORDED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const RECORDED_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/sidebar-content-search/ui.expected.md', import.meta.url))

/** Generate forty turns so the first matched message starts outside the tail page. */
function history(): string {
  const lines = [JSON.stringify({
    type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}',
    createdAt: 1784974100000, cwd: '{{cwd}}/workspace', isSeeded: false, delegationDepth: 0,
  })]
  let seq = 0
  const append = (event: Record<string, unknown>): void => {
    lines.push(JSON.stringify({ ...event, seq: seq++, time: 1784974100000 + seq }))
  }
  for (let turn = 1; turn <= 40; turn++) {
    append({ type: 'turn/start', data: { turn } })
    append({ type: 'step/start', data: { turn, step: 1 } })
    if (turn === 1) append({ type: 'system/message', data: { turn, step: 1, message: createSystemMessage('') }, surfaceOp: 'append' })
    append({ type: 'user/message', surfaceOp: 'append', data: {
      id: `00000000-0000-4000-9000-${String(turn).padStart(12, '0')}`, role: 'user',
      content: [{ type: 'text', text: turn === 1 ? '请复核预算确认Plan的边界条件。' : `Question ${turn}` }], source: { kind: 'user' },
    } })
    append({ type: 'assistant/message', surfaceOp: 'append', data: { stream: [], turn, step: 1, message: {
      id: `00000000-0000-4000-8000-${String(turn).padStart(12, '0')}`, role: 'assistant',
      content: [{ type: 'text', text: turn === 1 ? 'The **DSeArCh** implementation supports Chinese substrings.'
        : turn === 2 ? `${'A paragraph before the destination.\n\n'.repeat(100)}长文定位Needle在这里。` : `Answer ${turn}` }],
      source: { kind: 'model', provider: 'snapshot', model: 'snapshot-replier' },
    } } })
    if (turn === 1) append({ type: 'user/message',
      surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 }, sourceEventSeqs: [3, 4],
      data: { id: '00000000-0000-4000-9000-999999999999', role: 'user',
        content: [{ type: 'text', text: '用于模型上下文的压缩摘要。' }], source: { kind: 'user' } },
    })
    append({ type: 'step/end', data: { turn, step: 1 } })
    append({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  return `${lines.join('\n')}\n`
}

describe('sidebar content search', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, history(), 'sidebar-content-search')
    await seedSession(scaffold, await readFile(RECORDED, 'utf8'), 'sidebar-search-recorded')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Search sessions' }).waitFor()
  }, 120_000)
  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  const search = async (query: string, keyboard = false): Promise<void> => {
    await page.getByRole('button', { name: 'Search sessions' }).click()
    await page.getByPlaceholder('Search names or messages').fill(query)
    const results = page.getByRole('tree', { name: 'Search results' })
    await results.getByRole('treeitem').waitFor()
    if (keyboard) await results.getByRole('treeitem').press('Enter')
    else await results.getByRole('treeitem').click()
    await page.locator('[data-search-located]').waitFor()
    await expect.poll(async () => page.evaluate(() =>
      [...(CSS.highlights.get('dsh-search-match') ?? [])].map(range => range instanceof Range ? range.toString() : ''),
    )).not.toEqual([])
  }

  it('finds a cold Chinese fragment after context replacement and loads the message before the tail page', async () => {
    onTestFailed(() => saveFailureShot(page, 'sidebar-content-search'))
    await search('预算')
    const row = page.locator('[data-search-located]')
    expect(await row.textContent()).toContain('请复核预算确认Plan')
    await expect.poll(async () => row.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return bounds.top >= 0 && bounds.top < window.innerHeight
    })).toBe(true)
    await compareOrRefreshGolden(EXPECTED, await captureStableAria(page, '[data-search-located]', scaffold.workspaceCwd), webSnapshotMode())
  })

  it('replays recorded chat search without changing persisted messages', async () => {
    const before = await readPersistedEvents(scaffold, SessionId('sidebar-search-recorded'))
    await search('read tool twice')
    expect(await page.locator('[data-search-located]').textContent()).toContain('Use the read tool twice')
    await compareOrRefreshGolden(RECORDED_EXPECTED,
      await captureStableAria(page, '[data-chat-flow]', scaffold.workspaceCwd), webSnapshotMode())
    const after = await readPersistedEvents(scaffold, SessionId('sidebar-search-recorded'))
    // Opening a cold Session appends normal permission metadata; original messages stay intact.
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after.filter(event => event.type === 'user/message' || event.type === 'assistant/message'))
      .toEqual(before.filter(event => event.type === 'user/message' || event.type === 'assistant/message'))
  })

  it('lands on the highlighted text inside a long reply using keyboard activation', async () => {
    await search('定位Needle', true)
    await expect.poll(async () => page.evaluate(() => {
      const match = [...(CSS.highlights.get('dsh-search-match') ?? [])][0]
      if (!(match instanceof Range)) return false
      const bounds = match.getBoundingClientRect()
      return bounds.top >= 0 && bounds.bottom < window.innerHeight
    })).toBe(true)
    expect(await page.locator('[data-search-located]').evaluate(element =>
      getComputedStyle(element, '::highlight(dsh-search-match)').backgroundColor,
    )).toBe('rgb(255, 224, 130)')
    await saveFailureShot(page, 'sidebar-search-highlight')
  })

  it('supports one-character Chinese, mixed text, and case-insensitive English substrings', async () => {
    await search('预')
    await search('确认Plan')
    await search('search')
    expect(await page.locator('[data-search-located]').textContent()).toContain('DSeArCh')
    expect(tripwire.pageErrors).toEqual([])
  })
})

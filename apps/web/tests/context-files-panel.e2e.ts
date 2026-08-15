// Web e2e scenario: the context-and-files panel (dsh-client-ui-context-files)
// over the shipped surface. Zero model calls: the two-turn navigation seed
// supplies the transcript, the files tab reads the REAL host browse RPC
// against the scaffold workspace, and the context tab asserts its empty state
// (the seed log carries no injected instructions). A panel-aria golden pins
// the assembled presence of the shipped overlay entry.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page, Response } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/context-files-panel', import.meta.url))
const SEED_SOURCE = fileURLToPath(new URL('./snapshots/navigation-panes/seed.jsonl', import.meta.url))
const PANEL_EXPECTED = join(SNAPSHOT_DIR, 'panel.expected.md')
const MODE = webSnapshotMode()
const SEED_ID = 'context-files-panel-web-e2e'
/** Pre-created directory the files tab must surface through the host browse RPC. */
const MARKER_DIR = 'panel-fixture-dir'
/** Pre-created markdown file the preview pane must read through the host read route. */
const FIXTURE_FILE = 'panel-fixture.md'
const FIXTURE_FILE_BODY = '# Panel Fixture\n\n预览内容已就绪。\n'

async function baselineResponse(
  page: Page,
  method: 'session.list' | 'workspace.list',
): Promise<Response> {
  return page.waitForResponse(response => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/${method}`
  ), { timeout: 30_000 })
}

async function assertBaselineSucceeded(response: Response, method: string): Promise<void> {
  expect(response.ok(), `${method} baseline HTTP response`).toBe(true)
  const body = await response.json() as { result?: { ok?: unknown } }
  expect(body.result?.ok, `${method} baseline RPC result`).toBe(true)
}

/** Open the seeded session through the sidebar search flow. */
async function ensureSeedOpen(page: Page): Promise<void> {
  const welcome = page.locator('[class*="onboardingOverlay"]')
  if (await welcome.count() > 0) {
    await welcome.getByRole('button').click()
    await welcome.waitFor({ state: 'detached', timeout: 15_000 })
  }
  const chat = page.getByRole('tab', { name: 'Chat', exact: true })
  if (await chat.count() === 0) {
    const searchButton = page.getByRole('button', { name: 'Search sessions' })
    if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
    const search = page.getByPlaceholder('Search sessions', { exact: false })
    await search.fill('WATERFALL')
    const result = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
    await expect.poll(() => result.count(), { timeout: 15_000 }).toBe(1)
    await result.click()
    await chat.waitFor({ timeout: 15_000 })
    await search.fill('')
  }
  await chat.click()
  await page.getByText('FIRST_DONE', { exact: true }).waitFor({ timeout: 15_000 })
}

/** Open the panel on the files tab (the panel is persistent and already open). */
async function openPanelOnFiles(page: Page): Promise<void> {
  const panel = page.getByRole('region', { name: '上下文与文件面板' })
  await panel.waitFor({ timeout: 10_000 })
  await panel.getByRole('tab', { name: '文件夹' }).click()
}

describe('web e2e: context-and-files panel over the shipped surface', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole> = { warnings: [], pageErrors: [] }
  let slotErrors: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await mkdir(join(scaffold.workspaceCwd, MARKER_DIR), { recursive: true })
    await writeFile(join(scaffold.workspaceCwd, FIXTURE_FILE), FIXTURE_FILE_BODY)
    // Give the session's workspace a real git history so the commit-graph tab
    // has a commit to render (the keyless lane exercises the local git backend).
    const exec = promisify(execFile)
    await exec('git', ['-C', scaffold.workspaceCwd, 'init', '-b', 'main'])
    await exec('git', ['-C', scaffold.workspaceCwd, 'config', 'user.email', 'e2e@example.com'])
    await exec('git', ['-C', scaffold.workspaceCwd, 'config', 'user.name', 'e2e'])
    // Add only the fixture paths — the scaffold seeds several internal `.dsh-*`
    // directories beside them, and committing those would flood the commit's
    // file list past the backend's bound.
    await exec('git', ['-C', scaffold.workspaceCwd, 'add', MARKER_DIR, FIXTURE_FILE])
    await exec('git', ['-C', scaffold.workspaceCwd, 'commit', '-m', 'panel fixture commit'])
    if (MODE !== 'record') {
      const raw = await readFile(SEED_SOURCE, 'utf8')
      expect(fixtureUserPrompts(raw), 'seed fixture must carry its recorded prompts').toHaveLength(2)
      await seedSession(scaffold, raw, SEED_ID)
    }
    browser = await chromium.launch()
  }, 120_000)

  beforeEach(async () => {
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    slotErrors = []
    page.on('console', (message) => {
      if (message.type() === 'error' && /slot entry crashed/i.test(message.text())) {
        slotErrors.push(message.text())
      }
    })
    const sessionBaseline = baselineResponse(page, 'session.list')
    const workspaceBaseline = baselineResponse(page, 'workspace.list')
    const [, sessionResponse, workspaceResponse] = await Promise.all([
      page.goto(scaffold.baseUrl, { waitUntil: 'load' }),
      sessionBaseline,
      workspaceBaseline,
    ])
    await Promise.all([
      assertBaselineSucceeded(sessionResponse, 'session.list'),
      assertBaselineSucceeded(workspaceResponse, 'workspace.list'),
    ])
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByText('Ungrouped', { exact: true }).waitFor({ timeout: 30_000 })
  }, 120_000)

  afterEach(async () => {
    const failures: unknown[] = []
    try {
      expect({
        pageErrors: tripwire.pageErrors,
        slotErrors,
        warnings: tripwire.warnings,
      }).toEqual({ pageErrors: [], slotErrors: [], warnings: [] })
    } catch (error) {
      failures.push(error)
    }
    await page?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'panel case cleanup failed')
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'panel e2e cleanup failed')
  })

  it.skipIf(MODE === 'record')('lists the seeded workspace directory through the real host browse RPC', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-context-files-tree'))
    await ensureSeedOpen(page)
    await openPanelOnFiles(page)
    // The root row is the session cwd (unknown temp basename); expand the
    // first chevron and the pre-created marker directory must appear.
    await page.getByLabel(/^展开 /).first().click()
    await expect.poll(() => page.getByText(MARKER_DIR, { exact: true }).count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1)
    const snapshot = (await captureStableAria(page, '[aria-label="上下文与文件面板"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(PANEL_EXPECTED, snapshot, MODE)
  }, 90_000)

  it.skipIf(MODE === 'record')('previews a markdown file through the real host read route', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-context-files-preview'))
    await ensureSeedOpen(page)
    await openPanelOnFiles(page)
    await page.getByLabel(/^展开 /).first().click()
    // Clicking a file opens the centered preview (the shared Modal) directly.
    await page.getByLabel(`打开 ${FIXTURE_FILE}`).click()
    const dialog = page.getByRole('dialog', { name: FIXTURE_FILE })
    await dialog.waitFor({ timeout: 10_000 })
    await expect.poll(() => dialog.getByText('预览内容已就绪。', { exact: true }).count(), { timeout: 15_000 })
      .toBe(1)
    await dialog.getByLabel('关闭中部预览').click()
    await expect.poll(() => page.getByRole('dialog', { name: FIXTURE_FILE }).count(), { timeout: 5_000 }).toBe(0)
  }, 90_000)

  it.skipIf(MODE === 'record')('shows the empty context state for a seed without injected instructions', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-context-files-empty'))
    await ensureSeedOpen(page)
    const panel = page.getByRole('region', { name: '上下文与文件面板' })
    await panel.waitFor({ timeout: 10_000 })
    await expect.poll(() => panel.getByText('当前日志窗口内尚未注入任何上下文文档。').count(), { timeout: 10_000 })
      .toBe(1)
  }, 60_000)

  it.skipIf(MODE === 'record')('renders the git commit graph and expands a commit', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-context-files-git'))
    await ensureSeedOpen(page)
    const panel = page.getByRole('region', { name: '上下文与文件面板' })
    await panel.waitFor({ timeout: 10_000 })
    await panel.getByRole('tab', { name: 'Git' }).click()
    await expect.poll(() => panel.getByText('panel fixture commit', { exact: true }).count(), { timeout: 15_000 })
      .toBe(1)
    // Expanding the commit loads its changed files through the real host read route.
    await panel.getByText('panel fixture commit', { exact: true }).click()
    await expect.poll(() => panel.getByText(FIXTURE_FILE, { exact: true }).count(), { timeout: 15_000 })
      .toBe(1)
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the recorded snapshot inventory exact', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['panel.expected.md'])
  })
})

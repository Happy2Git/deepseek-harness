/**
 * Capture the panel screenshots the READMEs reference, from a real hermetic
 * web scaffold: boots the shipped web composition on a random port, seeds a
 * git repository with branches/merges/working-tree changes inside the
 * connected workspace, stages injected-context documents plus one compaction
 * checkpoint on the live session, then drives chromium through the four tabs
 * and the panel-file drop intake. A spec (not a plain script) because the
 * scaffold imports vitest's expect; the lane skips it unless the capture
 * directory is requested:
 *
 *   CAPTURE_OUT_DIR=release/screenshots/new pnpm exec vitest run \
 *     --config vitest.web.config.ts apps/web/tests/capture-screenshots.spec.ts
 */
import { describe, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import type { Page } from 'playwright'
import { launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const run = promisify(execFile)

/** One committed git step inside the seeded repository. */
async function git(repoDir: string, args: string[]): Promise<void> {
  await run('git', ['-C', repoDir, ...args], { encoding: 'utf8' })
}

/** Commit every pending change with the given message. */
async function commit(repoDir: string, message: string): Promise<void> {
  await git(repoDir, ['add', '-A'])
  await git(repoDir, ['commit', '-q', '-m', message])
}

/** A valid 1x1 transparent PNG (the drag-intake demo image). */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

/** The live session slice the capture reads and appends into (structural, no host imports). */
interface CaptureSession {
  header: { cwd?: string }
  events: readonly { seq: number }[]
  append: (type: 'user/message', data: unknown, opts: unknown) => void
}

/** Stage the context tab's documents: three shadowed by one compaction, one live after it. */
function stageContextDocs(session: {
  append: (type: 'user/message', data: unknown, opts: unknown) => void
  events: readonly { seq: number }[]
}): void {
  const first = session.events.length
  const doc = (source: unknown, text: string): void => {
    session.append('user/message', {
      id: `ctx-${session.events.length}`,
      role: 'user',
      source,
      content: [{ type: 'text', text }],
    }, { surfaceOp: 'append' })
  }
  doc(
    { kind: 'agent-instructions', form: 'instructions', changes: [{ path: 'AGENTS.md' }] },
    '# 工作区规则\n- 提交前先跑测试。\n- 不要修改 release/ 目录。',
  )
  doc(
    { kind: 'skill-invocation', name: 'dsh-pre-push-checks', form: 'catalog' },
    '调用技能 dsh-pre-push-checks,检查即将推送的改动。',
  )
  doc(
    { kind: 'session-reference', references: [{ label: '昨天的排查' }], form: 'recall' },
    '从昨天的排查会话带回了两个结论。',
  )
  // The compaction checkpoint shadows every document above it; its own
  // content is empty so the projection shows no checkpoint row.
  const last = session.events.length - 1
  session.append('user/message', {
    id: `ctx-${session.events.length}`,
    role: 'user',
    source: { kind: 'plugin', plugin: 'compact', compactionId: 'c-1' },
    content: [{ type: 'text', text: '' }],
  }, {
    surfaceOp: { op: 'replace', start: first, end: last },
    sourceEventSeqs: session.events.slice(first, last + 1).map(event => event.seq),
  })
  doc(
    { kind: 'plugin', plugin: 'dsh-goal', form: 'notice' },
    '目标:为面板补齐 git 视图。',
  )
}

const OUT_DIR = process.env.CAPTURE_OUT_DIR

describe.skipIf(OUT_DIR === undefined)('README screenshot capture', () => {
  it('captures the panel tabs and the drag intake into the requested directory', async () => {
    const outDir = OUT_DIR as string
    const scaffold = await launchWebScaffold()
    const browser = await chromium.launch()
    let page: Page | undefined
    try {
      const repoDir = join(scaffold.workspaceCwd, 'workspace')
      await mkdir(join(repoDir, 'src'), { recursive: true })
      await mkdir(join(repoDir, 'docs'), { recursive: true })
      await git(repoDir, ['init', '-b', 'main'])
      await git(repoDir, ['config', 'user.email', 'capture@example.com'])
      await git(repoDir, ['config', 'user.name', 'Capture'])
      await writeFile(join(repoDir, 'README.md'), 'compass 面板演示仓库\n')
      await commit(repoDir, '初始提交')
      await writeFile(join(repoDir, 'src', 'main.ts'), "console.log('hello')\n")
      await commit(repoDir, '搭建项目骨架')
      await git(repoDir, ['checkout', '-q', '-b', 'feature/pipeline'])
      await writeFile(join(repoDir, 'src', 'pipeline.ts'), 'export const stage = 1\n')
      await commit(repoDir, '接入流水线')
      await git(repoDir, ['checkout', '-q', 'main'])
      await writeFile(join(repoDir, 'README.md'), 'compass 面板演示仓库\n\n修正说明\n')
      await commit(repoDir, '修正文档')
      await git(repoDir, ['merge', '-q', '--no-ff', '-m', '合并流水线分支', 'feature/pipeline'])
      // Working-tree surface: one modified file, one untracked file, one image.
      await writeFile(join(repoDir, 'README.md'), 'compass 面板演示仓库\n\n新版本说明\n')
      await writeFile(join(repoDir, 'notes.txt'), '待办:截图之后清理。\n')
      await writeFile(join(repoDir, 'docs', 'screenshot.png'), TINY_PNG)
      await symlink('src', join(repoDir, 'linked'), 'dir')
      page = await newEnglishPage(browser)
      await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
      // Stage the context documents on the live session the picker created.
      const sessions = scaffold.ctx.sessions as unknown as { list: () => CaptureSession[] }
      // macOS tmpdir paths resolve through /var -> /private/var; accept the
      // picker's recorded cwd in either form.
      const realRepo = await realpath(repoDir)
      const session = sessions.list().find(candidate =>
        candidate.header.cwd === repoDir || candidate.header.cwd === realRepo)
      if (session === undefined) throw new Error('no session bound to the seeded repository')
      stageContextDocs(session)
      await page.waitForSelector('text=AGENTS.md', { timeout: 15_000 })
      await page.waitForSelector('text=历史流水', { timeout: 15_000 })
      await page.waitForSelector('text=dsh-pre-push-checks', { timeout: 15_000 })
      await page.screenshot({ path: join(outDir, '03-context-tab.png') })
      // Files tab: expand the root so the git status badges and dirs-first order show.
      await page.getByRole('tab', { name: '文件夹' }).click()
      await page.waitForSelector('text=workspace', { timeout: 15_000 })
      await page.getByRole('button', { name: /^展开 workspace$/ }).click()
      await page.waitForSelector('text=README.md', { timeout: 15_000 })
      await page.waitForSelector('[aria-label="git: 修改"]', { timeout: 15_000 })
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(outDir, '04-files-tab-dirs-first.png') })
      // Git tab: framed workspace block + framed commit tree with lanes and refs.
      await page.getByRole('tab', { name: 'Git' }).click()
      await page.waitForSelector('text=Git 树', { timeout: 15_000 })
      await page.waitForSelector('text=初始提交', { timeout: 15_000 })
      await page.waitForSelector('text=分支', { timeout: 15_000 })
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(outDir, '02-git-tab.png') })

      // The working-tree diff pop-out: click the modified file's workspace row
      // and capture the colored diff in the centered dialog.
      await page.locator('span[title="README.md"]').first().click()
      await page.waitForSelector('[role="dialog"][aria-label="README.md"]', { timeout: 15_000 })
      await page.waitForSelector('[data-diff-line="add"]', { timeout: 15_000 })
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(outDir, '06-workspace-diff.png') })
      await page.getByLabel('关闭中部预览').click()
      await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 15_000 })
      // The plain files tab (collapsed root) doubles as the tree overview shot.
      await page.getByRole('tab', { name: '文件夹' }).click()
      await page.waitForSelector('text=workspace', { timeout: 15_000 })
      await page.waitForTimeout(200)
      await page.screenshot({ path: join(outDir, '01-files-tab.png') })
      // Panel-file drag: dispatch a synthetic drop carrying the image path; the
      // composer folds the intake sentence into the draft. The root stays
      // expanded from the 04 shot, so the rows are already live.
      const imagePath = join(repoDir, 'docs', 'screenshot.png')
      await page.evaluate((path) => {
        const transfer = new DataTransfer()
        transfer.setData('application/x-dsh-path', path)
        document.body.dispatchEvent(new DragEvent('drop', {
          bubbles: true, cancelable: true, dataTransfer: transfer,
        }))
      }, imagePath)
      await page.waitForSelector('textarea:enabled', { timeout: 15_000 })
      await page.waitForFunction(
        () => document.querySelector('textarea')?.value.includes('Dropped image') === true,
        { timeout: 15_000 },
      )
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(outDir, '05-drag-image.png') })
    } finally {
      await page?.close().catch(() => {})
      await browser.close().catch(() => {})
      await scaffold.close().catch(() => {})
    }
  }, 600_000)
})

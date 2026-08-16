// @vitest-environment jsdom
/**
 * PanelRoot interaction spec under the four-share props form: a real panel
 * store instance, stubbed framework hooks, and recording injected callbacks.
 * Asserts the user-visible behavior: the docked toggle opens the panel, the
 * context tab lists injected documents and previews the selected one, the
 * refresh control re-reads, and the files tab renders the lazily loaded
 * directory tree with hidden entries filtered out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { DirectoryListing, DirectoryRead } from '@deepseek-ai/dsh-host-directory-picker'
import type { GitCommitDetail, GitFileDiff, GitGraphPage, GitStatusFile, GitWorkspaceStatus } from '@deepseek-ai/dsh-host-git'
import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { PanelRoot } from '@deepseek-ai/dsh-client-ui-context-files/src/client/PanelRoot.tsx'
import type { PanelRootProps } from '@deepseek-ai/dsh-client-ui-context-files/src/client/PanelRoot.tsx'
import { createPanelStore } from '@deepseek-ai/dsh-client-ui-context-files/src/client/store.ts'
import type { ContextDoc } from '@deepseek-ai/dsh-client-ui-context-files/src/client/types.ts'

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S { return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot)) }
}

const DOCS: ContextDoc[] = [
  { seq: 1, time: 1_000, role: 'inject', label: 'AGENTS.md', form: 'instructions', text: '# 规则\n只读工作区。', active: true },
  { seq: 2, time: 2_000, role: 'inject', label: 'goal', form: null, text: '当前目标:完成面板。', active: true },
]

const LISTING: DirectoryListing = {
  path: '/proj',
  home: '/home',
  crumbs: [
    { name: '/', path: '/', hidden: false, kind: 'directory' },
    { name: 'proj', path: '/proj', hidden: false, kind: 'directory' },
  ],
  entries: [
    { name: 'src', path: '/proj/src', hidden: false, kind: 'directory' },
    { name: 'notes.md', path: '/proj/notes.md', hidden: false, kind: 'file' },
    { name: 'data.json', path: '/proj/data.json', hidden: false, kind: 'file' },
    { name: 'blob.bin', path: '/proj/blob.bin', hidden: false, kind: 'file' },
    { name: '.git', path: '/proj/.git', hidden: true, kind: 'directory' },
  ],
  truncated: false,
}

const STATUS_FILES: GitStatusFile[] = [
  { name: 'notes.md', status: 'modified' },
  { name: 'data.json', status: 'untracked' },
  { name: '.git', status: 'ignored' },
]

const GRAPH_PAGE: GitGraphPage = {
  entries: [
    { hash: 'a'.repeat(40), parents: [], refs: 'HEAD -> main', message: '初始提交', author: '测试', date: '2026-01-01T00:00:00+00:00' },
    { hash: 'b'.repeat(40), parents: ['a'.repeat(40)], refs: '', message: '第二个提交', author: '测试', date: '2026-01-02T00:00:00+00:00' },
  ],
  hasMore: false,
}

const COMMIT_DETAIL: GitCommitDetail = {
  hash: 'a'.repeat(40),
  message: '初始提交',
  author: '测试',
  date: '2026-01-01T00:00:00+00:00',
  files: [{ path: 'README.md', status: 'added', additions: 3, deletions: 0 }],
  truncated: false,
}

const WORKSPACE: GitWorkspaceStatus = {
  branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0,
  files: [{ path: 'README.md', status: 'modified', additions: 1, deletions: 1 }],
  truncated: false,
}

/** The fetchDocEvents mock's exact call/assert shape. */
type FetchedFold = { docs: ContextDoc[]; boundary: number }
type FetchDocsMock = ReturnType<
  typeof vi.fn<(sessionId: SessionId, signal: AbortSignal) => Promise<FetchedFold>>
>

/** Build the complete props share around one fresh store instance. */
function makeProps(): {
  props: PanelRootProps
  listDirectory: ReturnType<typeof vi.fn<(path?: string, signal?: AbortSignal) => Promise<DirectoryListing>>>
  readText: ReturnType<typeof vi.fn>
  gitGraph: ReturnType<typeof vi.fn>
  gitShowCommit: ReturnType<typeof vi.fn>
  workspaceStatus: ReturnType<typeof vi.fn>
  showFileDiff: ReturnType<typeof vi.fn>
  showWorkspaceDiff: ReturnType<typeof vi.fn>
  gitStatusFor: ReturnType<typeof vi.fn>
  readInjectedDocs: ReturnType<typeof vi.fn>
  fetchDocEvents: FetchDocsMock
  bumpDocsStream: () => void
  setCurrent: (id: SessionId) => void
} {
  const instance = createPanelStore().create()
  const current = 's1' as SessionId
  const sessionState = {
    ids: [current, 's2' as SessionId],
    byId: {
      [current]: { id: current, displayTitle: '测试会话', cwd: '/proj', running: false, blank: false, updatedAt: 1 },
      s2: { id: 's2' as SessionId, displayTitle: '另一个会话', cwd: '/proj', running: false, blank: false, updatedAt: 1 },
    },
    current,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
  const setCurrent = (id: SessionId): void => { sessionState.current = id }
  // The docs-stream stub: a pushable snapshot the bound hook reads; bumping it
  // simulates the session stream advancing (a new reference, as the runtime
  // republishes per event batch).
  let streamValue = { sessionId: current, snapshot: {} as never }
  const streamListeners = new Set<() => void>()
  const docsStream = {
    getSnapshot: () => streamValue,
    subscribe: (fn: () => void) => {
      streamListeners.add(fn)
      return () => { streamListeners.delete(fn) }
    },
  }
  const bumpDocsStream = (): void => {
    streamValue = { sessionId: current, snapshot: {} as never }
    for (const fn of [...streamListeners]) fn()
  }
  const readInjectedDocs = vi.fn((): ContextDoc[] => DOCS)
  const fetchDocEvents = vi.fn<(sessionId: SessionId, signal: AbortSignal) => Promise<{ docs: ContextDoc[]; boundary: number }>>(
    async () => ({ docs: [], boundary: -1 }))
  const listDirectory = vi.fn<(path?: string, signal?: AbortSignal) => Promise<DirectoryListing>>(async () => LISTING)
  const readText = vi.fn(async (path: string): Promise<DirectoryRead> => {
    if (path.endsWith('.bin')) throw new Error('not a text file')
    return { path, text: path.endsWith('.md') ? '# 文件内容\n预览正文。' : '{"ok":true}', truncated: false }
  })
  const gitGraph = vi.fn(async (): Promise<GitGraphPage> => GRAPH_PAGE)
  const gitShowCommit = vi.fn(async (): Promise<GitCommitDetail> => COMMIT_DETAIL)
  const workspaceStatus = vi.fn(async (): Promise<GitWorkspaceStatus> => WORKSPACE)
  const showFileDiff = vi.fn(async (): Promise<GitFileDiff> => ({ path: 'README.md', diff: '+diff line\n', truncated: false }))
  const showWorkspaceDiff = vi.fn(async (): Promise<GitFileDiff> => ({ path: 'README.md', diff: '+working line\n', truncated: false }))
  const gitStatusFor = vi.fn(async (): Promise<GitStatusFile[]> => STATUS_FILES)
  const props = {
    useSessions: selector => selector(sessionState as SessionListState),
    useWorkspaces: () => ({}) as never,
    useStore: hookOf(instance.store),
    actions: instance.actions,
    renderSlot: () => null,
    useDocsStream: hookOf(docsStream),
    listDirectory,
    readText,
    openPath: vi.fn(async () => {}),
    gitGraph,
    gitShowCommit,
    workspaceStatus,
    showFileDiff,
    showWorkspaceDiff,
    gitStatusFor,
    readInjectedDocs,
    compactionBoundary: vi.fn((): number | null => null),
    fetchDocEvents,
    hasMoreDocs: vi.fn((): boolean => false),
    loadOlderDocs: vi.fn(async () => {}),
    sessionCwd: () => '/proj',
  } as PanelRootProps
  return {
    props, listDirectory, readText, gitGraph, gitShowCommit, workspaceStatus, showFileDiff, showWorkspaceDiff,
    gitStatusFor, readInjectedDocs, fetchDocEvents, bumpDocsStream, setCurrent,
  }
}

afterEach(() => {
  cleanup()
  // The panel store persists whole-state to localStorage; clear it so one
  // test's tab/width/expansion cannot rehydrate into the next.
  localStorage.clear()
})

// jsdom ships no matchMedia; the panel reads it once for the narrow-viewport
// auto-collapse. Stub a wide viewport (no auto-collapse) with inert listeners.
vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
}) as unknown as MediaQueryList))

describe('PanelRoot', () => {
  it('renders the persistent panel with both view tabs', () => {
    const { props } = makeProps()
    render(<PanelRoot {...props} />)
    expect(document.querySelector('section[aria-label="上下文与文件面板"]')).not.toBeNull()
    expect(screen.getByRole('tab', { name: '上下文' })).not.toBeNull()
    expect(screen.getByRole('tab', { name: '文件夹' })).not.toBeNull()
  })

  it('collapses to a rail and expands back through the mirror toggle', () => {
    const { props } = makeProps()
    render(<PanelRoot {...props} />)
    // Expanded: the collapse toggle is the only header control, the tabs show.
    const collapse = screen.getByRole('button', { name: '收起面板' })
    expect(screen.getByRole('tab', { name: '上下文' })).not.toBeNull()
    fireEvent.click(collapse)
    // Collapsed: the rail shows only the expand toggle; the tabs are gone.
    expect(screen.queryByRole('tab', { name: '上下文' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开面板' }))
    expect(screen.getByRole('tab', { name: '上下文' })).not.toBeNull()
  })

  it('lists the injected documents and opens one in the centered pop-out', () => {
    const { props } = makeProps()
    render(<PanelRoot {...props} />)
    expect(document.body.textContent).toContain('当前有效')
    expect(document.body.textContent).toContain('历史流水')
    expect(document.body.textContent).toContain('AGENTS.md')
    fireEvent.click(screen.getByText('AGENTS.md').closest('button')!)
    const modal = document.body.querySelector('[role="dialog"][aria-label="AGENTS.md"]')
    expect(modal).not.toBeNull()
    expect(modal!.textContent).toContain('只读工作区。')
    fireEvent.click(screen.getByLabelText('关闭中部预览'))
    expect(document.body.querySelector('[role="dialog"][aria-label="AGENTS.md"]')).toBeNull()
  })

  it('splits the live window from the shadowed history', () => {
    const { props } = makeProps()
    // The fold's boundary must agree with the fixture's active flags: the
    // checkpoint at seq 1 shadows old.md and leaves new.md live.
    ;(props.compactionBoundary as ReturnType<typeof vi.fn>).mockReturnValue(1)
    ;(props.readInjectedDocs as ReturnType<typeof vi.fn>).mockReturnValue([
      { seq: 1, time: 1_000, role: 'inject', label: 'old.md', form: 'instructions', text: '旧指令', active: false },
      { seq: 2, time: 2_000, role: 'inject', label: 'new.md', form: 'instructions', text: '新指令', active: true },
    ])
    render(<PanelRoot {...props} />)
    const active = screen.getByText('当前有效').closest('section')!
    const history = screen.getByText('历史流水').closest('section')!
    expect(active.textContent).toContain('new.md')
    expect(active.textContent).not.toContain('old.md')
    expect(history.textContent).toContain('old.md')
    expect(history.textContent).not.toContain('new.md')
  })

  it('renders the history stream newest first, matching the live window order', () => {
    const { props } = makeProps()
    ;(props.compactionBoundary as ReturnType<typeof vi.fn>).mockReturnValue(5)
    ;(props.readInjectedDocs as ReturnType<typeof vi.fn>).mockReturnValue([
      { seq: 1, time: 1_000, role: 'inject', label: 'old1', form: null, text: '最早', active: false },
      { seq: 3, time: 3_000, role: 'inject', label: 'old2', form: null, text: '次早', active: false },
      { seq: 6, time: 6_000, role: 'inject', label: 'live', form: null, text: '最新', active: true },
    ])
    render(<PanelRoot {...props} />)
    const active = screen.getByText('当前有效').closest('section')!
    const history = screen.getByText('历史流水').closest('section')!
    expect(active.textContent).toContain('live')
    expect(history.textContent.indexOf('old2')).toBeLessThan(history.textContent.indexOf('old1'))
  })

  it('filters both sections by the search query', () => {
    const { props } = makeProps()
    ;(props.readInjectedDocs as ReturnType<typeof vi.fn>).mockReturnValue([
      { seq: 1, time: 1_000, role: 'inject', label: 'AGENTS.md', form: 'instructions', text: '只读工作区。', active: true },
      { seq: 2, time: 2_000, role: 'inject', label: 'skill 调用', form: null, text: '检索了某个符号', active: true },
    ])
    render(<PanelRoot {...props} />)
    fireEvent.change(screen.getByLabelText('搜索注入文档'), { target: { value: '检索' } })
    expect(document.body.textContent).toContain('匹配结果')
    expect(document.body.textContent).toContain('skill 调用')
    expect(document.body.textContent).not.toContain('AGENTS.md')
  })

  it('refresh re-reads the injected documents', () => {
    const { props } = makeProps()
    render(<PanelRoot {...props} />)
    const { readInjectedDocs } = props
    const reader = readInjectedDocs as ReturnType<typeof vi.fn>
    const callsBefore = reader.mock.calls.length
    fireEvent.click(screen.getByText('刷新'))
    expect(reader.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it('re-projects the documents when the session stream advances, without a manual refresh', () => {
    const { props, readInjectedDocs, bumpDocsStream } = makeProps()
    render(<PanelRoot {...props} />)
    expect(document.body.textContent).toContain('AGENTS.md')
    // The agent injected a new document; the stream republishes its snapshot.
    readInjectedDocs.mockReturnValue([
      ...DOCS,
      { seq: 3, time: 3_000, role: 'inject', label: '新技能', form: null, text: '新注入的上下文。', active: true },
    ])
    act(() => { bumpDocsStream() })
    expect(document.body.textContent).toContain('新技能')
    expect(document.body.textContent).toContain('3 篇')
  })

  it('badges file instructions vs runtime context and pages older documents', async () => {
    const { props } = makeProps()
    const { readInjectedDocs, loadOlderDocs, hasMoreDocs } = props
    ;(hasMoreDocs as ReturnType<typeof vi.fn>).mockReturnValue(true)
    const reader = readInjectedDocs as ReturnType<typeof vi.fn>
    const loader = loadOlderDocs as ReturnType<typeof vi.fn>
    render(<PanelRoot {...props} />)
    expect(screen.getAllByText('指令文件').length).toBe(1)
    expect(screen.getAllByText('动态上下文').length).toBe(1)
    expect(loader).not.toHaveBeenCalled()
    const callsBefore = reader.mock.calls.length
    fireEvent.click(screen.getByText('加载更早的注入文档'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(loader).toHaveBeenCalledWith('s1')
    expect(reader.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it('offers paging from the empty window state', () => {
    const { props } = makeProps()
    ;(props.hasMoreDocs as ReturnType<typeof vi.fn>).mockReturnValue(true)
    ;(props.readInjectedDocs as ReturnType<typeof vi.fn>).mockReturnValue([])
    render(<PanelRoot {...props} />)
    expect(document.body.textContent).toContain('当前日志窗口内尚未注入任何上下文文档。')
    expect(screen.getByText('加载更早')).not.toBeNull()
  })

  it('the files tab renders the lazily loaded root directory', async () => {
    const { props, listDirectory } = makeProps()
    render(<PanelRoot {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: '文件夹' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(listDirectory).toHaveBeenCalledWith('/proj', expect.anything())
    expect(document.body.textContent).toContain('proj')
  })

  it('badges file rows with their git working-tree status', async () => {
    const { props, gitStatusFor } = makeProps()
    render(<PanelRoot {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: '文件夹' }))
    await act(async () => {
      await Promise.resolve()
    })
    // The status fetch resolves one microtask after the listing does.
    await act(async () => {
      await Promise.resolve()
    })
    expect(gitStatusFor).toHaveBeenCalledWith('/proj', expect.anything())
    // Child rows render once the root expands.
    fireEvent.click(screen.getByLabelText('展开 proj'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByLabelText('git: 修改')).not.toBeNull()
    expect(screen.getByLabelText('git: 未跟踪')).not.toBeNull()
    expect(document.body.textContent).not.toContain('git: 忽略')
  })

  it('file rows drag their absolute path for the composer intake', async () => {
    const { props } = makeProps()
    render(<PanelRoot {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: '文件夹' }))
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.click(screen.getByLabelText('展开 proj'))
    await act(async () => {
      await Promise.resolve()
    })
    const transfer = { setData: vi.fn(), effectAllowed: 'none' }
    fireEvent.dragStart(screen.getByLabelText('打开 notes.md'), { dataTransfer: transfer })
    expect(transfer.setData).toHaveBeenCalledWith('application/x-dsh-path', '/proj/notes.md')
    expect(transfer.effectAllowed).toBe('copy')
  })

  it('aborts the in-flight directory listing when the panel unmounts', async () => {
    const { props, listDirectory } = makeProps()
    listDirectory.mockImplementation(() => new Promise<DirectoryListing>(() => {}))
    const view = render(<PanelRoot {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: '文件夹' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(listDirectory).toHaveBeenCalledWith('/proj', expect.any(AbortSignal))
    const signal = (listDirectory.mock.calls[0] as [string, AbortSignal])[1]
    expect(signal.aborted).toBe(false)
    view.unmount()
    expect(signal.aborted).toBe(true)
  })

  it('opens a file in the centered preview and closes it', async () => {
    const { props, readText } = makeProps()
    render(<PanelRoot {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: '文件夹' }))
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.click(screen.getByLabelText('展开 proj'))
    await act(async () => {
      await Promise.resolve()
    })
    // Clicking a file opens the centered preview directly.
    fireEvent.click(screen.getByLabelText('打开 notes.md'))
    const modal = document.body.querySelector('[role="dialog"][aria-label="notes.md"]')
    expect(modal).not.toBeNull()
    await act(async () => {
      await Promise.resolve()
    })
    expect(readText).toHaveBeenCalledWith('/proj/notes.md', expect.anything())
    expect(document.body.textContent).toContain('预览正文。')
    fireEvent.click(screen.getByLabelText('关闭中部预览'))
    expect(document.body.querySelector('[role="dialog"][aria-label="notes.md"]')).toBeNull()
  })

  it('previews a non-markdown text file as plain text', async () => {
    const { props } = makeProps()
    render(<PanelRoot {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: '文件夹' }))
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.click(screen.getByLabelText('展开 proj'))
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.click(screen.getByLabelText('打开 data.json'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('{"ok":true}')
  })

  it('reports an unreadable binary file in the centered preview', async () => {
    const { props } = makeProps()
    render(<PanelRoot {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: '文件夹' }))
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.click(screen.getByLabelText('展开 proj'))
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.click(screen.getByLabelText('打开 blob.bin'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('无法预览:not a text file')
  })

  it('the files tab expands a directory by loading its children, hidden entries filtered', async () => {
    const { props, listDirectory } = makeProps()
    render(<PanelRoot {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: '文件夹' }))
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.click(screen.getByLabelText('展开 proj'))
    await act(async () => {
      await Promise.resolve()
    })
    // proj was already loaded on mount: expanding renders its cached children
    // (the src directory and the notes.md file leaf) without a refetch.
    // Expanding src loads its children.
    expect(screen.getByText('notes.md', { exact: true })).not.toBeNull()
    expect(screen.queryAllByLabelText(/^展开 notes/)).toHaveLength(0)
    fireEvent.click(screen.getByLabelText('展开 src'))
    expect(listDirectory).toHaveBeenCalledWith('/proj/src', expect.anything())
    await act(async () => {
      await Promise.resolve()
    })
    // The listing stub returns the same shape for any path, so src's child
    // directory points back at /proj/src — the cycle guard renders it as a
    // leaf row — and its own notes.md file row joins it.
    expect(screen.getByLabelText('折叠 src')).not.toBeNull()
    expect(screen.getAllByText('notes.md').length).toBe(2)
    expect(document.body.textContent).toContain('循环链接')
    expect(document.body.textContent).not.toContain('.git')
  })

  it('shows the no-session placeholder when no session is current', () => {
    const { props } = makeProps()
    props.useSessions = selector => selector({
      ids: [], byId: {}, current: undefined, phase: 'ready',
      subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    })
    render(<PanelRoot {...props} />)
    expect(document.body.textContent).toContain('选择会话后显示其已注入的上下文文档。')
  })

  it('the git tab renders the commit graph and expands a commit to its files', async () => {
    const { props, gitGraph, gitShowCommit } = makeProps()
    render(<PanelRoot {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Git' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(gitGraph).toHaveBeenCalledWith('/proj', expect.any(Number), 0, expect.anything())
    expect(document.body.textContent).toContain('初始提交')
    expect(document.body.textContent).toContain('第二个提交')
    // Expanding the first commit loads its changed files.
    fireEvent.click(screen.getByText('初始提交'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(gitShowCommit).toHaveBeenCalledWith('/proj', 'a'.repeat(40), expect.anything())
    expect(document.body.textContent).toContain('README.md')
    expect(document.body.textContent).toContain('新增')
  })

  it('shows the working-tree block with branch position and uncommitted files', async () => {
    const { props, workspaceStatus } = makeProps()
    render(<PanelRoot {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Git' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(workspaceStatus).toHaveBeenCalledWith('/proj', expect.anything())
    expect(document.body.textContent).toContain('工作区')
    expect(document.body.textContent).toContain('分支 main · 领先 1 · 落后 0')
    expect(document.body.textContent).toContain('README.md')
    expect(document.body.textContent).toContain('修改')
  })

  it('frames the commit tree with its own title and refreshes both reads', async () => {
    const { props, gitGraph, workspaceStatus } = makeProps()
    render(<PanelRoot {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Git' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('Git 树')
    expect(gitGraph).toHaveBeenCalledTimes(1)
    expect(workspaceStatus).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByLabelText('刷新 Git 视图'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(gitGraph).toHaveBeenCalledTimes(2)
    expect(workspaceStatus).toHaveBeenCalledTimes(2)
  })

  it('fetches the complete history out-of-band and merges it into the sections', async () => {
    const { props, fetchDocEvents } = makeProps()
    const { loadOlderDocs, hasMoreDocs } = props
    const fetchDocs = fetchDocEvents
    const loader = loadOlderDocs as ReturnType<typeof vi.fn>
    ;(hasMoreDocs as ReturnType<typeof vi.fn>).mockReturnValue(true)
    const OLD_DOC: ContextDoc = { seq: 3, time: 3_000, role: 'inject', label: '早期指令', form: 'instructions', text: '最早注入。', active: false }
    fetchDocs.mockResolvedValue({ docs: [OLD_DOC], boundary: 10 })
    render(<PanelRoot {...props} />)
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('早期指令')
    })
    // The shared conversation window stays untouched: the panel never pages it.
    expect(loader).not.toHaveBeenCalled()
  })

  it('fetches each session once and never pages the shared window', async () => {
    const { props, bumpDocsStream, fetchDocEvents } = makeProps()
    const { loadOlderDocs, hasMoreDocs } = props
    const fetchDocs = fetchDocEvents
    const loader = loadOlderDocs as ReturnType<typeof vi.fn>
    ;(hasMoreDocs as ReturnType<typeof vi.fn>).mockReturnValue(true)
    fetchDocs.mockResolvedValue({ docs: [], boundary: -1 })
    render(<PanelRoot {...props} />)
    await vi.waitFor(() => {
      expect(fetchDocs).toHaveBeenCalledTimes(1)
    })
    expect(loader).not.toHaveBeenCalled()
    // Stream advances never re-fetch the same session.
    act(() => { bumpDocsStream() })
    await act(async () => { await Promise.resolve() })
    expect(fetchDocs).toHaveBeenCalledTimes(1)
  })


  it('serves an already-fetched session from the per-session cache on switch-back', async () => {
    const { props, fetchDocEvents, bumpDocsStream, setCurrent } = makeProps()
    const fetchDocs = fetchDocEvents
    ;(props.hasMoreDocs as ReturnType<typeof vi.fn>).mockReturnValue(true)
    fetchDocs.mockImplementation(async (id: SessionId) => {
      if (id === 's1') {
        return { docs: [{ seq: 7, time: 7_000, role: 'inject', label: 'A 会话文档', form: null, text: 'A', active: false }], boundary: 10 }
      }
      return { docs: [{ seq: 8, time: 8_000, role: 'inject', label: 'B 会话文档', form: null, text: 'B', active: false }], boundary: 20 }
    })
    render(<PanelRoot {...props} />)
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('A 会话文档')
    })
    // Switch to s2, then back to s1: the cache serves s1 instantly, and s2's
    // documents never leak into s1.
    act(() => { setCurrent('s2' as SessionId) })
    act(() => { bumpDocsStream() })
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('B 会话文档')
    })
    const callsAfterS2 = fetchDocs.mock.calls.length
    act(() => { setCurrent('s1' as SessionId) })
    act(() => { bumpDocsStream() })
    await act(async () => { await Promise.resolve() })
    expect(fetchDocs).toHaveBeenCalledTimes(callsAfterS2)
    expect(document.body.textContent).toContain('A 会话文档')
    expect(document.body.textContent).not.toContain('B 会话文档')
  })

  it('opens the file diff in the centered pop-out from a commit row', async () => {
    const { props, showFileDiff } = makeProps()
    render(<PanelRoot {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Git' }))
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.click(screen.getByText('初始提交'))
    await act(async () => {
      await Promise.resolve()
    })
    // The workspace block lists README.md too; the click targets the row
    // inside the expanded commit.
    const commitRow = screen.getByText('初始提交').closest('div')!
    fireEvent.click(within(commitRow).getByText('README.md'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(showFileDiff).toHaveBeenCalledWith('/proj', 'a'.repeat(40), 'README.md', expect.anything())
    expect(document.body.querySelector('[role="dialog"]')!.textContent).toContain('+diff line')
    // The unified diff renders colored: the added line carries its role.
    expect(document.body.querySelector('[data-diff-line="add"]')?.textContent).toBe('+diff line')
  })

  it('opens the working-tree diff from a workspace row', async () => {
    const { props, showWorkspaceDiff } = makeProps()
    render(<PanelRoot {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Git' }))
    await act(async () => {
      await Promise.resolve()
    })
    // The workspace block lists README.md (modified); clicking the row opens
    // the working-tree diff instead of a commit diff.
    fireEvent.click(screen.getByTitle('README.md'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(showWorkspaceDiff).toHaveBeenCalledWith('/proj', 'README.md', expect.anything())
    expect(document.body.querySelector('[role="dialog"]')!.textContent).toContain('+working line')
    expect(document.body.querySelector('[data-diff-line="add"]')?.textContent).toBe('+working line')
    fireEvent.click(screen.getByLabelText('关闭中部预览'))
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })
})

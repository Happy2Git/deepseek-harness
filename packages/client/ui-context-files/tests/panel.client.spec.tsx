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
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { DirectoryListing, DirectoryRead } from '@deepseek-ai/dsh-host-directory-picker'
import type { GitCommitDetail, GitGraphPage } from '@deepseek-ai/dsh-host-git'
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
  { seq: 1, time: 1_000, role: 'inject', label: 'AGENTS.md', form: 'instructions', text: '# 规则\n只读工作区。' },
  { seq: 2, time: 2_000, role: 'inject', label: 'goal', form: null, text: '当前目标:完成面板。' },
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

/** Build the complete props share around one fresh store instance. */
function makeProps(): {
  props: PanelRootProps
  listDirectory: ReturnType<typeof vi.fn>
  readText: ReturnType<typeof vi.fn>
  gitGraph: ReturnType<typeof vi.fn>
  gitShowCommit: ReturnType<typeof vi.fn>
} {
  const instance = createPanelStore().create()
  const current = 's1' as SessionId
  const sessionState = {
    ids: [current],
    byId: {
      [current]: { id: current, displayTitle: '测试会话', cwd: '/proj', running: false, blank: false, updatedAt: 1 },
    },
    current,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  } as SessionListState
  const listDirectory = vi.fn(async (): Promise<DirectoryListing> => LISTING)
  const readText = vi.fn(async (path: string): Promise<DirectoryRead> => {
    if (path.endsWith('.bin')) throw new Error('not a text file')
    return { path, text: path.endsWith('.md') ? '# 文件内容\n预览正文。' : '{"ok":true}', truncated: false }
  })
  const gitGraph = vi.fn(async (): Promise<GitGraphPage> => GRAPH_PAGE)
  const gitShowCommit = vi.fn(async (): Promise<GitCommitDetail> => COMMIT_DETAIL)
  const props = {
    useSessions: selector => selector(sessionState),
    useWorkspaces: () => ({}) as never,
    useStore: hookOf(instance.store),
    actions: instance.actions,
    renderSlot: () => null,
    listDirectory,
    readText,
    openPath: vi.fn(async () => {}),
    gitGraph,
    gitShowCommit,
    readInjectedDocs: vi.fn((): ContextDoc[] => DOCS),
    hasMoreDocs: vi.fn((): boolean => true),
    loadOlderDocs: vi.fn(async () => {}),
    sessionCwd: () => '/proj',
  } as PanelRootProps
  return { props, listDirectory, readText, gitGraph, gitShowCommit }
}

afterEach(() => { cleanup() })

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
    expect(document.body.textContent).toContain('已注入 2 篇')
    expect(document.body.textContent).toContain('AGENTS.md')
    fireEvent.click(document.body.querySelector('li button')!)
    const modal = document.body.querySelector('[role="dialog"][aria-label="AGENTS.md"]')
    expect(modal).not.toBeNull()
    expect(modal!.textContent).toContain('只读工作区。')
    fireEvent.click(screen.getByLabelText('关闭中部预览'))
    expect(document.body.querySelector('[role="dialog"][aria-label="AGENTS.md"]')).toBeNull()
  })

  it('refresh re-reads the injected documents', () => {
    const { props } = makeProps()
    render(<PanelRoot {...props} />)
    const reader = props.readInjectedDocs as ReturnType<typeof vi.fn>
    const callsBefore = reader.mock.calls.length
    fireEvent.click(screen.getByText('刷新'))
    expect(reader.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it('badges file instructions vs runtime context and pages older documents', async () => {
    const { props } = makeProps()
    const reader = props.readInjectedDocs as ReturnType<typeof vi.fn>
    const loader = props.loadOlderDocs as ReturnType<typeof vi.fn>
    render(<PanelRoot {...props} />)
    expect(screen.getAllByText('指令文件').length).toBe(1)
    expect(screen.getAllByText('动态上下文').length).toBe(1)
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
    } as SessionListState)
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
})

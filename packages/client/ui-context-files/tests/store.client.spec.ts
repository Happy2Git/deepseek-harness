// @vitest-environment jsdom
/**
 * createPanelStore unit account: init shape, the action write set, and
 * instance independence. Uses the test-sanctioned path: factory self-call +
 * .create() gives the real engine instance (same create path as production).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPanelStore } from '@deepseek-ai/dsh-client-ui-context-files/src/client/store.ts'

beforeEach(() => { localStorage.clear() })

describe('createPanelStore', () => {
  it('initializes on the context tab with no selection', () => {
    const { store } = createPanelStore().create()
    expect(store.getSnapshot()).toEqual({
      tab: 'context',
      filter: '',
      expandedDirs: [],
      centerFile: null,
      centerDocSeq: null,
      collapsed: false,
      width: 280,
    })
  })

  it('setTab switches the active view and setFilter writes the filter', () => {
    const { store, actions } = createPanelStore().create()
    actions.setTab('files')
    actions.setFilter('src')
    expect(store.getSnapshot()).toMatchObject({ tab: 'files', filter: 'src' })
  })

  it('toggleDir adds then removes a directory path', () => {
    const { store, actions } = createPanelStore().create()
    actions.toggleDir('/proj/src')
    expect(store.getSnapshot().expandedDirs).toEqual(['/proj/src'])
    actions.toggleDir('/proj/src')
    expect(store.getSnapshot().expandedDirs).toEqual([])
  })

  it('openDocCenter writes and closeCenter clears the centered document', () => {
    const { store, actions } = createPanelStore().create()
    actions.openDocCenter(7)
    expect(store.getSnapshot().centerDocSeq).toBe(7)
    actions.closeCenter()
    expect(store.getSnapshot().centerDocSeq).toBeNull()
  })

  it('openCenter/closeCenter drive the centered pop-out', () => {
    const { store, actions } = createPanelStore().create()
    actions.openCenter('/proj/notes.md')
    expect(store.getSnapshot().centerFile).toBe('/proj/notes.md')
    actions.closeCenter()
    expect(store.getSnapshot().centerFile).toBeNull()
  })

  it('toggleCollapsed flips the collapsed flag', () => {
    const { store, actions } = createPanelStore().create()
    expect(store.getSnapshot().collapsed).toBe(false)
    actions.toggleCollapsed()
    expect(store.getSnapshot().collapsed).toBe(true)
    actions.toggleCollapsed()
    expect(store.getSnapshot().collapsed).toBe(false)
  })

  it('setWidth writes the expanded width', () => {
    const { store, actions } = createPanelStore().create()
    actions.setWidth(360)
    expect(store.getSnapshot().width).toBe(360)
  })

  it('each create() is an independent instance (factory is not a singleton)', () => {
    const a = createPanelStore().create()
    const b = createPanelStore().create()
    a.actions.setTab('files')
    expect(b.store.getSnapshot()).toMatchObject({ tab: 'context' })
  })

  it('rehydrates width, tab, and collapse from the persisted storage (reload)', () => {
    const first = createPanelStore().create()
    first.actions.setTab('git')
    first.actions.setWidth(340)
    first.actions.toggleCollapsed()
    const second = createPanelStore().create()
    expect(second.store.getSnapshot()).toMatchObject({ tab: 'git', width: 340, collapsed: true })
  })

  it('clears a rehydrated centered pop-out before any render can show it', () => {
    const first = createPanelStore().create()
    first.actions.openCenter('/proj/notes.md')
    first.actions.openDocCenter(7)
    first.actions.closeCenter()
    first.actions.openCenter('/proj/again.md')
    const second = createPanelStore().create()
    expect(second.store.getSnapshot()).toMatchObject({ centerFile: null, centerDocSeq: null })
  })
})

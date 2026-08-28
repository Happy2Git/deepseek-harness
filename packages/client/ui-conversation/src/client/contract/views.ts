/** Shared conversation view, selection, and store-state contracts. */

/** Tool call identity as carried on the wire (branded upstream in connection). */
export type CallId = string

/** One locate request: the event seq to reveal, plus the search text that
 * produced the hit (when the caller is a search surface) so the revealed row
 * can highlight the matching words. */
export interface LocateRequest {
  seq: number
  query?: string
}

/** Selection target for the details linkage channel (toolcall is the step special case). */
export interface SelectionTarget { turnSeq: number; stepSeq?: number; callId?: CallId; toolName?: string }

/**
 * One conversation view tab, projected from a 'conversation.view' slot
 * entry's registration options (label falls back to the entry id).
 */
export interface ViewTab { id: string; label: string }

/**
 * Per-session state shared by conversation, chat-view, and details slots.
 * Unknown persisted view ids fall back to the stable Chat view.
 */
export interface ChatStoreState {
  /** Details-linkage channel (conversation writes, details reads). */
  selection: SelectionTarget | null
  /** Composer draft (persisted; survives session switches and reloads). */
  draft: string
  /** Active conversation view id ('conversation.view' entry id); null falls back to Chat. */
  view: string | null
  /**
   * One-shot inspect handoff: chat writes the call to reveal, the trajectory
   * view consumes it and acknowledges by clearing. Read with `?? null` —
   * persisted snapshots from before this field rehydrate without it.
   */
  inspect: { callId: CallId } | null
  /**
   * One-shot locate handoff: a search surface writes the event seq to reveal,
   * the chat view scrolls that row into view, flags it, and acknowledges by
   * clearing. The request survives history paging — chat keeps it pending
   * until the seq is inside the loaded window. Read with `?? null`, as
   * snapshots persisted before this field rehydrate without it.
   *
   * `query` is the search text that produced the hit, carried so the view can
   * highlight the matching words inside the revealed row; it is absent on
   * callers that only locate without a search phrase.
   */
  locate: { seq: number; query?: string } | null
}

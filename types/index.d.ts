export type SessionState =
  | 'needs-you'
  | 'decision'
  | 'running'
  | 'subagent'
  | 'thinking'
  | 'polling'
  | 'idle'

export type SessionRow = {
  pid: number
  sessionId: string
  hostId: string
  title: string
  state: SessionState
  doing: string
  step: string
  prompt: string
  ageSeconds: number
}

export type Board = { rows: SessionRow[]; error: string }

/** The card being dragged and the card it would land on. */
export type DragTarget = { id: string; targetId: string } | null

/** The last message sent from a card; a new `sentCount` empties its field. */
export type SendStatus = { text: string; isError: boolean; sentCount: number }

declare module 'claude-code' {
  interface PluginState {
    'session-board': {
      board: Shaped<Board>
      expanded: Shaped<string[]>
      hidden: Shaped<string[]>
      order: Shaped<string[]>
      drag: Shaped<DragTarget>
      sends: Shaped<Record<string, SendStatus>>
    }
  }
}

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

/** The last message sent from a card; a new `sentCount` empties its field. */
export type SendStatus = { text: string; isError: boolean; sentCount: number }

declare module 'claude-code' {
  interface PluginState {
    'session-board': {
      board: Shaped<Board>
      expanded: Shaped<string[]>
      hidden: Shaped<string[]>
      sends: Shaped<Record<string, SendStatus>>
      isPicking: Shaped<boolean>
    }
  }
}

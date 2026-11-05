import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Catalog, SendStatus, SessionRow, SessionState } from '../types'
import type { CardProps, Motion } from './card'

const PANE = 'session-board'
const POLL_MS = 3000
const HIDDEN_KEY = 'hidden'
const SESSION_SERVER = 'ccd_session_mgmt'
const CATALOG_LIMIT = 100
// The most a Select may hold; a longer list stops the whole pane drawing.
const MAX_PICKER_OPTIONS = 64
const EMPTY: Board = { rows: [], error: '' }
const board = atom({ plugin: 'session-board', key: 'board' } as const, EMPTY, {
  shape: 'board-2',
})
const sends = atom(
  { plugin: 'session-board', key: 'sends' } as const,
  {} as Record<string, SendStatus>,
  { shape: 'sends-1' },
)
const expanded = atom(
  { plugin: 'session-board', key: 'expanded' } as const,
  [] as string[],
  { shape: 'expanded-2' },
)
const hidden = atom(
  { plugin: 'session-board', key: 'hidden' } as const,
  [] as string[],
  { shape: 'hidden-1' },
)
const isPicking = atom({ plugin: 'session-board', key: 'isPicking' } as const, false, {
  shape: 'picking-1',
})
const NO_CATALOG: Catalog = { sessions: [], error: '', isLoaded: false }
const catalog = atom({ plugin: 'session-board', key: 'catalog' } as const, NO_CATALOG, {
  shape: 'catalog-2',
})

const LABEL: Record<SessionState, string> = {
  'needs-you': 'Needs you',
  decision: 'Your call',
  running: 'Running',
  subagent: 'Subagent',
  thinking: 'Thinking',
  polling: 'Polling',
  idle: 'Idle',
}

// Blue means the session is waiting on the person.
const COLOR: Record<SessionState, string> = {
  'needs-you': 'blue',
  decision: 'blue',
  running: 'success',
  subagent: 'success',
  thinking: 'success',
  polling: 'warning',
  idle: 'inactive',
}

const MOTION: Record<SessionState, Motion> = {
  'needs-you': 'pulse',
  decision: 'pulse',
  running: 'spin',
  subagent: 'spin',
  thinking: 'spin',
  polling: 'sweep',
  idle: 'none',
}

// What the activity line means in each state, shown beside it when expanded.
const DOING_LABEL: Record<SessionState, string> = {
  'needs-you': 'Waiting on',
  decision: 'Question',
  running: 'Now',
  subagent: 'Now',
  thinking: 'Latest',
  polling: 'Now',
  idle: 'Last',
}

// A session's process id changes on restart, its app id does not.
const idOf = (row: SessionRow) => row.hostId || String(row.pid)

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`

  return `${Math.floor(seconds / 3600)}h`
}

function summarize(rows: SessionRow[]): string {
  const count = (states: SessionState[]) =>
    rows.filter(row => states.includes(row.state)).length
  const waiting = count(['needs-you', 'decision'])
  const working = count(['running', 'subagent', 'thinking', 'polling'])

  return `${rows.length} live · ${waiting} waiting on you · ${working} working`
}

function toCardProps(row: SessionRow, isOpen: boolean): CardProps {
  const details = [
    ...(row.doing !== LABEL[row.state]
      ? [{ label: DOING_LABEL[row.state], value: row.doing }]
      : []),
    ...(row.step ? [{ label: 'Step', value: row.step }] : []),
    ...(row.prompt ? [{ label: 'You asked', value: row.prompt }] : []),
  ]

  return {
    id: idOf(row),
    title: row.title,
    status: `${LABEL[row.state]} · ${formatAge(row.ageSeconds)}`,
    color: COLOR[row.state],
    motion: MOTION[row.state],
    isOpen,
    isDim: row.state === 'idle',
    details,
  }
}

async function refresh($: EngineInterface): Promise<void> {
  const script = `${$.plugin.root}/bin/snapshot.py`
  let next: Board
  try {
    const ran = await $.process.run(['/usr/bin/env', 'python3', '-I', script])
    next =
      ran.exitCode === 0
        ? { rows: JSON.parse(ran.stdout).rows, error: '' }
        : { rows: [], error: ran.stderr.slice(-300) || `Exit ${ran.exitCode}` }
  } catch (error) {
    next = { rows: [], error: String(error).slice(0, 300) }
  }
  await update($, board, () => next)
}

async function setHidden($: EngineInterface, ids: string[]): Promise<void> {
  await update($, hidden, () => ids)
  await $.store.set(HIDDEN_KEY, ids)
}

async function loadCatalog($: EngineInterface): Promise<void> {
  let next: Catalog
  try {
    const result = await $.mcp.call(SESSION_SERVER, 'list_sessions', { limit: CATALOG_LIMIT })
    const text = result.content.map(block => block.text ?? '').join('')
    if (result.isError) throw new Error(text)
    const listed = JSON.parse(text) as { sessionId: string; title?: string }[]
    next = {
      sessions: listed.map(one => ({ id: one.sessionId, title: one.title || 'Untitled' })),
      error: '',
      isLoaded: true,
    }
  } catch (error) {
    next = { sessions: [], error: String(error).slice(0, 200), isLoaded: true }
  }
  await update($, catalog, () => next)
}

const openInApp = ($: EngineInterface, id: string) =>
  $.process.run(['open', `claude://claude.ai/epitaxy/${id}`])

/** Delivers `text` to a session; a failure keeps the text in the field. */
async function sendMessage($: EngineInterface, row: SessionRow, text: string): Promise<void> {
  if (!text.trim()) return
  const id = idOf(row)
  const setStatus = (next: Omit<SendStatus, 'sentCount'>, didSend: boolean) =>
    update($, sends, all => {
      const sentCount = all[id]?.sentCount ?? 0

      return { ...all, [id]: { ...next, sentCount: didSend ? sentCount + 1 : sentCount } }
    })
  await setStatus({ text: 'Sending…', isError: false }, false)
  try {
    const result = await $.mcp.call(SESSION_SERVER, 'send_message', {
      session_id: row.hostId,
      message: text,
    })
    const reply = result.content.map(block => block.text ?? '').join(' ')
    const delivery = /delivery: ([a-z_]+)/.exec(reply)?.[1]
    if (result.isError || (delivery !== 'delivered' && delivery !== 'queued')) {
      await setStatus({ text: `Not sent: ${reply.slice(0, 200)}`, isError: true }, false)
    } else {
      const label = delivery === 'delivered' ? 'Sent' : 'Queued until it finishes'
      await setStatus({ text: label, isError: false }, true)
    }
  } catch (error) {
    await setStatus({ text: `Not sent: ${String(error).slice(0, 200)}`, isError: true }, false)
  }
}

const toggleOpen = ($: EngineInterface, id: string) =>
  update($, expanded, ids =>
    ids.includes(id) ? ids.filter(one => one !== id) : [...ids, id],
  )

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sessions',
      description: 'Show every live Claude session in a pane',
    })
    const saved = await $.store.get(HIDDEN_KEY)
    if (Array.isArray(saved)) await update($, hidden, () => saved.map(String))
    let isRefreshing = false
    const tick = async () => {
      if (isRefreshing) return
      isRefreshing = true
      try {
        await refresh($)
      } finally {
        isRefreshing = false
      }
    }
    await tick()
    $.clock.every(POLL_MS, () => void tick())
    void $.ui.open({ id: PANE, title: 'Sessions' })

    return next(e)
  })

  on('command.run', { command: 'sessions' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Sessions' })

    return { text: 'Sessions pane opened.' }
  })

  on('ui.message', async ($, e, next) => {
    const data = e.data as { type?: string; id?: string } | null
    if (e.requestId !== PANE || !data?.id) return next(e)
    if (data.type === 'toggle') await toggleOpen($, data.id)
    if (data.type === 'hide') await setHidden($, [...(await read($, hidden)), data.id])

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    const Client = 'Client' in table ? table.Client : undefined
    const Input = 'Input' in table ? table.Input : undefined
    const Select = 'Select' in table ? table.Select : undefined
    const { rows, error } = await read($, board)

    if (error) return <Text color="error">{error}</Text>

    const open = await read($, expanded)
    const hiddenIds = await read($, hidden)
    const sendStatus = await read($, sends)
    const picking = await read($, isPicking)
    const selfId = await $.session.id()
    const shown = rows.filter(row => !hiddenIds.includes(idOf(row)))
    const known = await read($, catalog)
    const onBoard = new Set(shown.map(idOf))
    const removed = rows
      .filter(row => hiddenIds.includes(idOf(row)))
      .map(row => ({ id: idOf(row), title: row.title }))
    const removedIds = new Set(removed.map(one => one.id))
    const addable = [
      ...removed,
      ...known.sessions.filter(one => !onBoard.has(one.id) && !removedIds.has(one.id)),
    ]
    const liveIds = new Set(rows.map(idOf))
    const jump = (row: SessionRow) => void openInApp($, row.hostId)
    const togglePicker = async () => {
      if (!picking) {
        await update($, catalog, () => NO_CATALOG)
        void loadCatalog($)
      }
      await update($, isPicking, () => !picking)
    }
    // A running session just comes back; a stopped one has to start first, and
    // its card appears once the snapshot sees it live.
    const pick = async (id: string) => {
      if (hiddenIds.includes(id)) await setHidden($, hiddenIds.filter(one => one !== id))
      if (!liveIds.has(id)) await openInApp($, id)
      await update($, isPicking, () => false)
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>{summarize(shown)}</Text>
        {Select ? (
          <Button key="add-session" onPress={() => void togglePicker()}>
            {picking ? 'Cancel' : '+ Add session'}
          </Button>
        ) : null}
        {picking && known.error ? <Text color="error">{known.error}</Text> : null}
        {picking && !known.isLoaded ? <Text dimColor>Loading sessions…</Text> : null}
        {picking && known.isLoaded && !known.error && addable.length === 0 ? (
          <Text dimColor>No other sessions to add</Text>
        ) : null}
        {picking && Select && addable.length > 0 ? (
          <Select
            key="pick-session"
            options={addable
              .slice(0, MAX_PICKER_OPTIONS)
              .map(one => ({ value: one.id, label: one.title }))}
            onSelect={id => void pick(id)}
          />
        ) : null}
        {shown.map(row => {
          const id = idOf(row)
          const isOpen = open.includes(id)
          const card = toCardProps(row, isOpen)

          return (
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor={row.state === 'idle' ? 'subtle' : COLOR[row.state]}
            >
              {Client ? (
                <Client key={`card-${id}`} module="./card.tsx" props={card} width="100%" />
              ) : (
                <Box flexDirection="column" paddingX={1}>
                  <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
                    <Button
                      key={`toggle-${id}`}
                      plain
                      onPress={() => void toggleOpen($, id)}
                    >
                      {isOpen ? '▾ ' : '▸ '}
                      {card.title}
                    </Button>
                    <Button
                      key={`hide-${id}`}
                      plain
                      label="✕"
                      onPress={() => void setHidden($, [...hiddenIds, id])}
                    />
                  </Box>
                  <Text color={card.color}>{card.status}</Text>
                  {isOpen
                    ? card.details.map(detail => (
                        <Text>
                          {detail.label}: {detail.value}
                        </Text>
                      ))
                    : null}
                </Box>
              )}
              {isOpen && row.hostId ? (
                <Box flexDirection="column" gap={1} paddingX={1} marginTop={1}>
                  {Input && row.sessionId !== selfId ? (
                    <Input
                      key={`message-${id}-${sendStatus[id]?.sentCount ?? 0}`}
                      placeholder="Message this session"
                      submitLabel="send"
                      onSubmit={text => void sendMessage($, row, text)}
                    />
                  ) : null}
                  {sendStatus[id] ? (
                    <Text
                      color={sendStatus[id].isError ? 'error' : undefined}
                      dimColor={!sendStatus[id].isError}
                    >
                      {sendStatus[id].text}
                    </Text>
                  ) : null}
                  <Button key={`open-${id}`} onPress={() => jump(row)}>
                    Open session
                  </Button>
                </Box>
              ) : null}
            </Box>
          )
        })}
        {hiddenIds.length > 0 ? (
          <Button key="show-all" plain onPress={() => void setHidden($, [])}>
            {`${hiddenIds.length} hidden · Show all`}
          </Button>
        ) : null}
      </Box>
    )
  })
}

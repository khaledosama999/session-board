import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, DragTarget, SendStatus, SessionRow, SessionState } from '../types'
import type { CardProps, Motion } from './card'

const PANE = 'session-board'
const POLL_MS = 3000
const HIDDEN_KEY = 'hidden'
const SESSION_SERVER = 'ccd_session_mgmt'
const ORDER_KEY = 'order'
// A card's rows when it has not reported them yet, and the rows of border and
// gap around each card.
const DEFAULT_CARD_ROWS = 2
const CARD_CHROME_ROWS = 3
const EMPTY: Board = { rows: [], error: '' }
const NO_DRAG: DragTarget = null
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
const order = atom(
  { plugin: 'session-board', key: 'order' } as const,
  [] as string[],
  { shape: 'order-1' },
)
const drag = atom({ plugin: 'session-board', key: 'drag' } as const, NO_DRAG, {
  shape: 'drag-1',
})
const cardRows = new Map<string, number>()

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

/**
 * The shown rows, in the person's order. A session they have not placed yet
 * comes first, in status order, so a new one is not missed.
 */
function arrange(rows: SessionRow[], hiddenIds: string[], placed: string[]): SessionRow[] {
  const rank = (row: SessionRow) => placed.indexOf(idOf(row))

  return rows
    .filter(row => !hiddenIds.includes(idOf(row)))
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
    .map(({ row }) => row)
}

/** Where a card lands in the list when dropped `dy` rows from where it was. */
function landingIndex(ids: string[], from: number, dy: number): number {
  const span = (id: string | undefined) =>
    (id && cardRows.get(id) ? cardRows.get(id)! : DEFAULT_CARD_ROWS) + CARD_CHROME_ROWS
  const step = dy > 0 ? 1 : -1
  let index = from
  let passed = 0
  while (index + step >= 0 && index + step < ids.length) {
    const next = span(ids[index + step])
    if (Math.abs(dy) <= passed + next / 2) break
    passed += next
    index += step
  }

  return index
}

async function shownIds($: EngineInterface): Promise<string[]> {
  const { rows } = await read($, board)
  const shown = arrange(rows, await read($, hidden), await read($, order))

  return shown.map(idOf)
}

async function setOrder($: EngineInterface, ids: string[]): Promise<void> {
  await update($, order, () => ids)
  await $.store.set(ORDER_KEY, ids)
}

async function dropCard($: EngineInterface, id: string, dy: number): Promise<void> {
  await update($, drag, () => null)
  const ids = await shownIds($)
  const from = ids.indexOf(id)
  if (from < 0) return
  const to = landingIndex(ids, from, dy)
  if (to === from) return
  const moved = ids.filter(one => one !== id)
  moved.splice(to, 0, id)
  // Hidden and stopped sessions keep their place for when they return.
  const others = (await read($, order)).filter(one => !ids.includes(one))
  await setOrder($, [...moved, ...others])
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
    const savedHidden = await $.store.get(HIDDEN_KEY)
    if (Array.isArray(savedHidden)) await update($, hidden, () => savedHidden.map(String))
    const savedOrder = await $.store.get(ORDER_KEY)
    if (Array.isArray(savedOrder)) await update($, order, () => savedOrder.map(String))
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
    const data = e.data as { type?: string; id?: string; dy?: number; rows?: number } | null
    if (e.requestId !== PANE || !data?.id) return next(e)
    const { id, type, dy = 0, rows = 0 } = data
    if (type === 'toggle') await toggleOpen($, id)
    if (type === 'hide') await setHidden($, [...(await read($, hidden)), id])
    if (type === 'size') cardRows.set(id, rows)
    if (type === 'drop') await dropCard($, id, dy)
    if (type === 'drag') {
      const ids = await shownIds($)
      const targetId = ids[landingIndex(ids, ids.indexOf(id), dy)] ?? id
      await update($, drag, () => ({ id, targetId }))
    }

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    const Client = 'Client' in table ? table.Client : undefined
    const { rows, error } = await read($, board)
    const open = await read($, expanded)
    const hiddenIds = await read($, hidden)
    const placed = await read($, order)
    const dragging = await read($, drag)
    const shown = arrange(rows, hiddenIds, placed)
    const jump = (row: SessionRow) =>
      void $.process.run(['open', `claude://claude.ai/epitaxy/${row.hostId}`])

    if (error) return <Text color="error">{error}</Text>

    const selfId = await $.session.id()
    const sendStatus = await read($, sends)
    const Input = 'Input' in table ? table.Input : undefined

    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>{summarize(shown)}</Text>
        {shown.map(row => {
          const id = idOf(row)
          const isOpen = open.includes(id)
          const card = toCardProps(row, isOpen)
          const isDropTarget = dragging?.targetId === id && dragging.id !== id
          const stateBorder = row.state === 'idle' ? 'subtle' : COLOR[row.state]

          return (
            <Box
              flexDirection="column"
              borderStyle={isDropTarget ? 'double' : 'round'}
              borderColor={isDropTarget ? 'claude' : stateBorder}
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
                    <Text color={sendStatus[id].isError ? 'error' : undefined} dimColor={!sendStatus[id].isError}>
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
        {hiddenIds.length > 0 || placed.length > 0 ? (
          <Box flexDirection="row" gap={2}>
            {hiddenIds.length > 0 ? (
              <Button key="show-all" plain onPress={() => void setHidden($, [])}>
                {`${hiddenIds.length} hidden · Show all`}
              </Button>
            ) : null}
            {placed.length > 0 ? (
              <Button key="sort-status" plain onPress={() => void setOrder($, [])}>
                Sort by status
              </Button>
            ) : null}
          </Box>
        ) : null}
      </Box>
    )
  })
}

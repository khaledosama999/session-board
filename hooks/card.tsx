import type { ClientModule, ClientPointerEvent } from 'claude-code'

export type Motion = 'spin' | 'pulse' | 'sweep' | 'none'

export type CardProps = {
  id: string
  title: string
  status: string
  color: string
  motion: Motion
  isOpen: boolean
  isDim: boolean
  details: { label: string; value: string }[]
}

type CardState = {
  frame: number
  isHover: boolean
  isDragging: boolean
  downAt: { x: number; y: number } | null
}

const FRAME_MS = 150
// Rows the pointer must travel before a press becomes a drag, not a click.
const DRAG_ROWS = 2
// Columns at the end of the title row that belong to the X, not the card.
const CLOSE_COLUMNS = 4
const INITIAL: CardState = { frame: 0, isHover: false, isDragging: false, downAt: null }
const GLYPHS: Record<Motion, string[]> = {
  spin: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  pulse: ['●', '●', '◉', '◎', '○', '◎', '◉', '●'],
  sweep: ['◐', '◐', '◓', '◓', '◑', '◑', '◒', '◒'],
  none: ['●'],
}
// The timer outlives each draw, so it reads the latest motion from here.
const motions = new Map<string, Motion>()
const reportedRows = new Map<string, number>()

const Card: ClientModule<CardProps, CardState> = (props, surface) => {
  const { Box, Button, Text } = surface.elements
  const { id } = props
  motions.set(id, props.motion)

  if (surface.rows > 0 && reportedRows.get(id) !== surface.rows) {
    reportedRows.set(id, surface.rows)
    surface.post({ type: 'size', id, rows: surface.rows })
  }

  if (surface.state === undefined) {
    surface.setState(INITIAL)
    surface.every(FRAME_MS, () => {
      if (motions.get(id) === 'none') return
      const now = surface.state ?? INITIAL
      surface.setState({ ...now, frame: now.frame + 1 })
    })
    surface.onPointer((event: ClientPointerEvent) => {
      const now = surface.state ?? INITIAL
      if (event.type === 'enter') surface.setState({ ...now, isHover: true })
      if (event.type === 'leave') surface.setState({ ...now, isHover: false })
      if (event.type === 'down' && event.button === 'left') {
        surface.setState({ ...now, downAt: { x: event.x, y: event.y } })
      }
      if (event.type === 'move' && now.downAt) {
        const dy = event.y - now.downAt.y
        if (!now.isDragging && Math.abs(dy) >= DRAG_ROWS) {
          surface.setState({ ...now, isDragging: true })
          surface.post({ type: 'drag', id, dy })
        } else if (now.isDragging) {
          surface.post({ type: 'drag', id, dy })
        }
      }
      if (event.type === 'up' && event.button === 'left' && now.downAt) {
        const dy = event.y - now.downAt.y
        const isSamePlace = Math.abs(event.x - now.downAt.x) <= 2 && Math.abs(dy) <= 1
        const isOnClose = event.y === 0 && event.x >= surface.columns - CLOSE_COLUMNS
        surface.setState({ ...now, downAt: null, isDragging: false })
        if (now.isDragging) surface.post({ type: 'drop', id, dy })
        else if (isSamePlace && !isOnClose) surface.post({ type: 'toggle', id })
      }
    })
  }

  const state = surface.state ?? INITIAL
  const glyphs = GLYPHS[props.motion]
  const glyph = state.isDragging ? '↕' : glyphs[state.frame % glyphs.length]

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Text>
          {props.isOpen ? '▾ ' : '▸ '}
          <Text color={props.color}>{glyph} </Text>
          <Text bold dimColor={props.isDim || state.isDragging} underline={state.isHover}>
            {props.title}
          </Text>
        </Text>
        <Button
          key={`hide-${id}`}
          plain
          label="✕"
          onPress={() => surface.post({ type: 'hide', id })}
        />
      </Box>
      <Text color={props.color}>{state.isDragging ? 'Drop to move' : props.status}</Text>
      {props.isOpen
        ? props.details.map(detail => (
            <Text>
              <Text dimColor>{detail.label}: </Text>
              {detail.value}
            </Text>
          ))
        : null}
    </Box>
  )
}

export default Card

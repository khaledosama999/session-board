import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-board',
  component: 'Pane',
  requestId: 'session-board',
  surface: 'desktop',
  props: {
    title: 'Sessions',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const row = (over: object) => ({
  pid: 1,
  sessionId: 'uuid-one',
  hostId: 'local_one',
  title: 'One',
  state: 'running',
  doing: 'Bash: Run tests',
  step: '2/5 Write tests',
  prompt: 'Fix the login bug',
  ageSeconds: 90,
  ...over,
})

const ran = (stdout: string, exitCode = 0, stderr = '') => ({
  value: {
    exitCode,
    stdout,
    stderr,
    isStdoutTruncated: false,
    isStderrTruncated: false,
  },
})

function world(on: On, rows: object[], argvs: unknown[] = [], saved?: unknown[]) {
  mock.clock(on)
  on('session.id', () => ({ value: 'uuid-self' }))
  if (saved) {
    on('store.get', () => ({ value: undefined }))
    on('store.set', (_, e) => {
      saved.push(e.value)

      return { value: undefined }
    })
  } else {
    mock.store(on)
  }
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    argvs.push(e.argv)

    return ran(JSON.stringify({ rows }))
  })
}

const start = { cwd: '/', surface: 'desktop', isInteractive: true } as const
const CARD = { in: 'card-local_one' }

test('a collapsed card shows title and state, not details', async ($, on) => {
  world(on, [row({})])
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  expect((await ui.find({ type: 'Text', text: /live/ }))?.text).toBe(
    '1 live · 0 waiting on you · 1 working',
  )
  expect((await ui.find({ type: 'Text', text: /Running/, ...CARD }))?.text).toBe('Running · 1m')
  expect(await ui.find({ type: 'Text', text: /Bash/, ...CARD })).toBeUndefined()
  await ui.unmount()
})

test('a click anywhere on the card expands it, a second collapses it', async ($, on) => {
  world(on, [row({})])
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)
  await ui.resize({ columns: 60, rows: 40, ...CARD })
  const click = async (y: number) => {
    await ui.pointer({ type: 'down', x: 20, y, button: 'left', ...CARD })
    await ui.pointer({ type: 'up', x: 20, y, button: 'left', ...CARD })
  }

  await click(1)
  expect((await ui.find({ type: 'Text', text: /Bash/, ...CARD }))?.text).toBe(
    'Now: Bash: Run tests',
  )
  expect((await ui.find({ type: 'Text', text: /login/, ...CARD }))?.text).toBe(
    'You asked: Fix the login bug',
  )

  await click(0)
  expect(await ui.find({ type: 'Text', text: /Bash/, ...CARD })).toBeUndefined()
  await ui.unmount()
})

test('a drag does not count as a click', async ($, on) => {
  world(on, [row({})])
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', ...CARD })
  await ui.pointer({ type: 'up', x: 2, y: 6, button: 'left', ...CARD })

  expect(await ui.find({ type: 'Text', text: /Bash/, ...CARD })).toBeUndefined()
  await ui.unmount()
})

test('dragging a card down moves it, and Sort by status undoes it', async ($, on) => {
  const saved: unknown[] = []
  world(
    on,
    [row({}), row({ pid: 2, hostId: 'local_two', title: 'Two' })],
    [],
    saved,
  )
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', ...CARD })
  await ui.pointer({ type: 'move', x: 2, y: 6, button: 'left', ...CARD })
  expect((await ui.find({ type: 'Text', text: /Drop to move/, ...CARD }))?.text).toBe(
    'Drop to move',
  )
  await ui.pointer({ type: 'up', x: 2, y: 6, button: 'left', ...CARD })

  expect(saved).toEqual([['local_two', 'local_one']])
  expect(await ui.find({ type: 'Text', text: /Bash/, ...CARD })).toBeUndefined()

  await ui.press({ key: 'sort-status' })
  expect(saved).toEqual([['local_two', 'local_one'], []])
  await ui.unmount()
})

test('a short drag leaves the order alone', async ($, on) => {
  const saved: unknown[] = []
  world(
    on,
    [row({}), row({ pid: 2, hostId: 'local_two', title: 'Two' })],
    [],
    saved,
  )
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', ...CARD })
  await ui.pointer({ type: 'move', x: 2, y: 2, button: 'left', ...CARD })
  await ui.pointer({ type: 'up', x: 2, y: 2, button: 'left', ...CARD })

  expect(saved).toEqual([])
  await ui.unmount()
})

test('a click on the X does not also expand the card', async ($, on) => {
  world(on, [row({})])
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)
  await ui.resize({ columns: 40, rows: 40, ...CARD })

  await ui.pointer({ type: 'down', x: 39, y: 0, button: 'left', ...CARD })
  await ui.pointer({ type: 'up', x: 39, y: 0, button: 'left', ...CARD })

  expect(await ui.find({ type: 'Text', text: /Bash/, ...CARD })).toBeUndefined()
  await ui.unmount()
})

test('the dot animates while working and stays still when idle', async ($, on) => {
  world(on, [row({}), row({ pid: 2, hostId: 'local_two', state: 'idle' })])
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)
  const glyph = async (id: string) =>
    (await ui.find({ type: 'Text', text: /▸/, in: `card-${id}` }))?.text

  const before = await glyph('local_one')
  const idleBefore = await glyph('local_two')
  await ui.advance(150)

  expect(await glyph('local_one')).not.toBe(before)
  expect(await glyph('local_two')).toBe(idleBefore)
  await ui.unmount()
})

test('X removes a session, stays removed, and Show all restores it', async ($, on) => {
  const saved: unknown[] = []
  world(on, [row({}), row({ pid: 2, hostId: 'local_two', title: 'Two' })], [], saved)
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.press({ key: 'hide-local_one', ...CARD })
  expect((await ui.find({ type: 'Text', text: /live/ }))?.text).toBe(
    '1 live · 0 waiting on you · 1 working',
  )
  expect(saved).toEqual([['local_one']])

  await ui.press({ key: 'show-all' })
  expect((await ui.find({ type: 'Text', text: /live/ }))?.text).toBe(
    '2 live · 0 waiting on you · 2 working',
  )
  expect(saved).toEqual([['local_one'], []])
  await ui.unmount()
})

test('Open session opens that session in the app', async ($, on) => {
  const argvs: unknown[] = []
  world(on, [row({})], argvs)
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.post({ type: 'toggle', id: 'local_one' }, CARD)
  await ui.press({ key: 'open-local_one' })
  await ui.unmount()

  expect(argvs).toContainEqual(['open', 'claude://claude.ai/epitaxy/local_one'])
})

const reply = (text: string, isError = false) => ({
  value: { content: [{ type: 'text', text }], isError },
})

test('a message goes to that session and the field empties', async ($, on) => {
  const calls: unknown[] = []
  world(on, [row({})])
  on('mcp.call', (_, e) => {
    calls.push(e)

    return reply('Done (delivery: delivered; message_id: m1)')
  })
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.post({ type: 'toggle', id: 'local_one' }, CARD)
  await ui.input({ key: 'message-local_one-0', text: 'Ship it' })

  expect(calls).toHaveLength(1)
  expect(JSON.stringify(calls[0])).toContain('send_message')
  expect(JSON.stringify(calls[0])).toContain('local_one')
  expect(JSON.stringify(calls[0])).toContain('Ship it')
  expect((await ui.find({ type: 'Text', text: /^Sent$/ }))?.text).toBe('Sent')
  expect(await ui.find({ key: 'message-local_one-0' })).toBeUndefined()
  expect(await ui.find({ key: 'message-local_one-1' })).toBeDefined()
  await ui.unmount()
})

test('a queued message says so', async ($, on) => {
  world(on, [row({})])
  on('mcp.call', () => reply('Waiting (delivery: queued; message_id: m2)'))
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.post({ type: 'toggle', id: 'local_one' }, CARD)
  await ui.input({ key: 'message-local_one-0', text: 'Next' })

  expect((await ui.find({ type: 'Text', text: /Queued/ }))?.text).toBe('Queued until it finishes')
  await ui.unmount()
})

test('a refused message shows why and keeps the field', async ($, on) => {
  world(on, [row({})])
  on('mcp.call', () => reply('Session not found', true))
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.post({ type: 'toggle', id: 'local_one' }, CARD)
  await ui.input({ key: 'message-local_one-0', text: 'Next' })

  expect((await ui.find({ type: 'Text', text: /Not sent/ }))?.text).toBe(
    'Not sent: Session not found',
  )
  expect(await ui.find({ key: 'message-local_one-0' })).toBeDefined()
  await ui.unmount()
})

test('a blank message is not sent', async ($, on) => {
  const calls: unknown[] = []
  world(on, [row({})])
  on('mcp.call', (_, e) => {
    calls.push(e)

    return reply('(delivery: delivered; message_id: m3)')
  })
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.post({ type: 'toggle', id: 'local_one' }, CARD)
  await ui.input({ key: 'message-local_one-0', text: '   ' })

  expect(calls).toHaveLength(0)
  await ui.unmount()
})

test('the card of this very session has no message box', async ($, on) => {
  world(on, [row({ sessionId: 'uuid-self' })])
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.post({ type: 'toggle', id: 'local_one' }, CARD)

  expect(await ui.find({ key: 'message-local_one-0' })).toBeUndefined()
  expect(await ui.find({ key: 'open-local_one' })).toBeDefined()
  await ui.unmount()
})

test('a failed snapshot shows the error', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ran('', 1, 'python3: not found'))
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  expect((await ui.find({ type: 'Text' }))?.text).toBe('python3: not found')
  await ui.unmount()
})

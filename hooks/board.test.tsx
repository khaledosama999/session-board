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

const two = row({ pid: 2, sessionId: 'uuid-two', hostId: 'local_two', title: 'Two' })

const ran = (stdout: string, exitCode = 0, stderr = '') => ({
  value: {
    exitCode,
    stdout,
    stderr,
    isStdoutTruncated: false,
    isStderrTruncated: false,
  },
})

const reply = (text: string, isError = false) => ({
  value: { content: [{ type: 'text' as const, text }], isError },
})

type World = {
  rows?: object[]
  argvs?: unknown[]
  saved?: Record<string, unknown>
  stored?: Record<string, unknown>
  sent?: unknown[]
  sessions?: object[]
  sendReply?: ReturnType<typeof reply>
  files?: Map<string, string>
  submitted?: unknown[]
}

const HOME = '/home/me'
const BOARD_DIR = `${HOME}/.claude/session-board`

function world(on: On, options: World = {}) {
  const { rows = [row({})], argvs = [], saved = {}, stored = {} } = options
  const files = options.files ?? new Map<string, string>()
  const clock = mock.clock(on)
  mock.env(on, { HOME })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)

    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)

    return { value: text }
  })
  on('fs.list', (_, e) => ({
    value: [...files.keys()]
      .filter(path => path.startsWith(`${e.path}/`) && !path.slice(e.path.length + 1).includes('/'))
      .map(path => ({
        name: path.slice(e.path.length + 1),
        kind: 'file' as const,
        size: 0,
        mtimeMs: 0,
        isLink: false,
      })),
  }))
  on('prompt.submit', (_, e) => {
    options.submitted?.push(e)

    return { text: e.text }
  })
  on('session.id', () => ({ value: 'uuid-self' }))
  on('store.get', (_, e) => ({ value: stored[e.key] }))
  on('store.set', (_, e) => {
    saved[e.key] = e.value

    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    argvs.push(e.argv)
    const [command, from = '', to = ''] = e.argv as string[]
    if (command === 'mv') {
      const text = files.get(from)
      if (text === undefined) return ran('', 1, 'No such file')
      files.delete(from)
      files.set(to, text)

      return ran('')
    }
    if (command === 'rm') {
      files.delete(e.argv[2] as string)

      return ran('')
    }

    return ran(JSON.stringify({ rows }))
  })
  on('mcp.call', (_, e) => {
    if (JSON.stringify(e).includes('list_sessions')) {
      return reply(JSON.stringify(options.sessions ?? []))
    }
    options.sent?.push(e)

    return options.sendReply ?? reply('Done (delivery: delivered; message_id: m1)')
  })

  return clock
}

const start = { cwd: '/', surface: 'desktop', isInteractive: true } as const
const CARD = { in: 'card-local_one' }

test('a collapsed card shows title and state, not details', async ($, on) => {
  world(on)
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
  world(on)
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

test('a press dragged away is not a click, and moves nothing', async ($, on) => {
  const saved: Record<string, unknown> = {}
  world(on, { rows: [row({}), two], saved })
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', ...CARD })
  await ui.pointer({ type: 'move', x: 2, y: 6, button: 'left', ...CARD })
  await ui.pointer({ type: 'up', x: 2, y: 6, button: 'left', ...CARD })

  expect(await ui.find({ type: 'Text', text: /Bash/, ...CARD })).toBeUndefined()
  expect(saved).toEqual({})
  await ui.unmount()
})

test('a click on the X does not also expand the card', async ($, on) => {
  world(on)
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)
  await ui.resize({ columns: 40, rows: 40, ...CARD })

  await ui.pointer({ type: 'down', x: 39, y: 0, button: 'left', ...CARD })
  await ui.pointer({ type: 'up', x: 39, y: 0, button: 'left', ...CARD })

  expect(await ui.find({ type: 'Text', text: /Bash/, ...CARD })).toBeUndefined()
  await ui.unmount()
})

test('the dot animates while working and stays still when idle', async ($, on) => {
  world(on, { rows: [row({}), row({ pid: 2, hostId: 'local_two', state: 'idle' })] })
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
  const saved: Record<string, unknown> = {}
  world(on, { rows: [row({}), two], saved })
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.press({ key: 'hide-local_one', ...CARD })
  expect((await ui.find({ type: 'Text', text: /live/ }))?.text).toBe(
    '1 live · 0 waiting on you · 1 working',
  )
  expect(saved.hidden).toEqual(['local_one'])

  await ui.press({ key: 'show-all' })
  expect((await ui.find({ type: 'Text', text: /live/ }))?.text).toBe(
    '2 live · 0 waiting on you · 2 working',
  )
  expect(saved.hidden).toEqual([])
  await ui.unmount()
})

const stopped = { sessionId: 'local_stopped', title: 'Stopped one' }

test('the picker lists stopped and removed sessions, not ones on the board', async ($, on) => {
  world(on, {
    rows: [row({}), two],
    stored: { hidden: ['local_two'] },
    sessions: [{ sessionId: 'local_one', title: 'One' }, stopped],
  })
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.press({ key: 'add-session' })
  await ui.advance(0)
  const drawn = JSON.stringify(await ui.drawn())

  expect(drawn).toContain('Stopped one')
  expect(drawn).toContain('local_two')
  expect(drawn).not.toContain('"value":"local_one"')
  await ui.unmount()
})

test('picking a removed running session brings it back without opening it', async ($, on) => {
  const saved: Record<string, unknown> = {}
  const argvs: unknown[] = []
  world(on, { rows: [row({}), two], saved, argvs, stored: { hidden: ['local_one', 'local_two'] } })
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.press({ key: 'add-session' })
  await ui.select({ key: 'pick-session', value: 'local_two' })

  expect(saved.hidden).toEqual(['local_one'])
  expect((await ui.find({ type: 'Text', text: /live/ }))?.text).toBe(
    '1 live · 0 waiting on you · 1 working',
  )
  expect(await ui.find({ key: 'pick-session' })).toBeUndefined()
  expect(JSON.stringify(argvs)).not.toContain('claude://')
  await ui.unmount()
})

test('picking a stopped session opens it and adds no card yet', async ($, on) => {
  const argvs: unknown[] = []
  world(on, { argvs, sessions: [stopped] })
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.press({ key: 'add-session' })
  await ui.advance(0)
  await ui.select({ key: 'pick-session', value: 'local_stopped' })

  expect(argvs).toContainEqual(['open', 'claude://claude.ai/epitaxy/local_stopped'])
  expect((await ui.find({ type: 'Text', text: /live/ }))?.text).toBe(
    '1 live · 0 waiting on you · 1 working',
  )
  expect(JSON.stringify(await ui.drawn())).not.toContain('card-local_stopped')
  await ui.unmount()
})

test('a removed session with no running process gets no card', async ($, on) => {
  world(on, { rows: [row({})], stored: { hidden: ['local_gone'] } })
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  expect((await ui.find({ type: 'Text', text: /live/ }))?.text).toBe(
    '1 live · 0 waiting on you · 1 working',
  )
  await ui.unmount()
})

test('the picker still draws with more sessions than a Select can hold', async ($, on) => {
  const sessions = Array.from({ length: 100 }, (_, index) => ({
    sessionId: `local_${index}`,
    title: `Session ${index}`,
  }))
  world(on, { sessions })
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.press({ key: 'add-session' })
  await ui.advance(0)

  const picker = await ui.find({ key: 'pick-session' })
  expect(picker?.props.options).toHaveLength(64)
  expect((await ui.find({ type: 'Text', text: /live/ }))?.text).toBe(
    '1 live · 0 waiting on you · 1 working',
  )
  await ui.unmount()
})

test('the picker says so when nothing is left to add', async ($, on) => {
  world(on)
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.press({ key: 'add-session' })
  await ui.advance(0)

  expect((await ui.find({ type: 'Text', text: /No other/ }))?.text).toBe(
    'No other sessions to add',
  )
  await ui.unmount()
})

test('the picker shows why the list could not load', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('session.id', () => ({ value: 'uuid-self' }))
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ran(JSON.stringify({ rows: [row({})] })))
  on('mcp.call', () => reply('No such server', true))
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.press({ key: 'add-session' })
  await ui.advance(0)

  expect((await ui.find({ type: 'Text', text: /No such server/ }))?.text).toContain('No such server')
  await ui.unmount()
})

test('Open session opens that session in the app', async ($, on) => {
  const argvs: unknown[] = []
  world(on, { argvs })
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.post({ type: 'toggle', id: 'local_one' }, CARD)
  await ui.press({ key: 'open-local_one' })
  await ui.unmount()

  expect(argvs).toContainEqual(['open', 'claude://claude.ai/epitaxy/local_one'])
})

test('without the mod there, a message goes through the app and the field empties', async ($, on) => {
  const sent: unknown[] = []
  world(on, { sent })
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.post({ type: 'toggle', id: 'local_one' }, CARD)
  await ui.input({ key: 'message-local_one-0', text: 'Ship it' })

  expect(sent).toHaveLength(1)
  expect(JSON.stringify(sent[0])).toContain('send_message')
  expect(JSON.stringify(sent[0])).toContain('local_one')
  expect(JSON.stringify(sent[0])).toContain('Ship it')
  expect((await ui.find({ type: 'Text', text: /^Sent/ }))?.text).toBe(
    'Sent, labeled from this session',
  )
  expect(await ui.find({ key: 'message-local_one-0' })).toBeUndefined()
  expect(await ui.find({ key: 'message-local_one-1' })).toBeDefined()
  await ui.unmount()
})

test('a queued message says so', async ($, on) => {
  world(on, { sendReply: reply('Waiting (delivery: queued; message_id: m2)') })
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.post({ type: 'toggle', id: 'local_one' }, CARD)
  await ui.input({ key: 'message-local_one-0', text: 'Next' })

  expect((await ui.find({ type: 'Text', text: /Queued/ }))?.text).toBe(
    'Queued until it finishes, labeled from this session',
  )
  await ui.unmount()
})

test('a refused message shows why and keeps the field', async ($, on) => {
  world(on, { sendReply: reply('Session not found', true) })
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
  const sent: unknown[] = []
  world(on, { sent })
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.post({ type: 'toggle', id: 'local_one' }, CARD)
  await ui.input({ key: 'message-local_one-0', text: '   ' })

  expect(sent).toHaveLength(0)
  await ui.unmount()
})

test('the card of this very session has no message box', async ($, on) => {
  world(on, { rows: [row({ sessionId: 'uuid-self' })] })
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

test('with the mod there, a message goes to its inbox, not through the app', async ($, on) => {
  const sent: unknown[] = []
  const files = new Map<string, string>()
  const clock = world(on, { sent, files })
  files.set(`${BOARD_DIR}/alive/uuid-one`, String(clock.now()))
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.post({ type: 'toggle', id: 'local_one' }, CARD)
  await ui.input({ key: 'message-local_one-0', text: 'Ship it' })

  expect(sent).toHaveLength(0)
  const waiting = [...files].filter(([path]) => path.startsWith(`${BOARD_DIR}/inbox/uuid-one/`))
  expect(waiting).toHaveLength(1)
  expect(waiting[0]?.[1]).toBe('Ship it')
  expect((await ui.find({ type: 'Text', text: /^Sent/ }))?.text).toBe('Sent as you')
  expect(await ui.find({ key: 'message-local_one-1' })).toBeDefined()
  await ui.unmount()
})

test('a mod that stopped checking in gets the app message instead', async ($, on) => {
  const sent: unknown[] = []
  const files = new Map<string, string>()
  const clock = world(on, { sent, files })
  files.set(`${BOARD_DIR}/alive/uuid-one`, String(clock.now() - 60_000))
  await $.session.start(start)
  const ui = await $.ui.mount(PANE)

  await ui.post({ type: 'toggle', id: 'local_one' }, CARD)
  await ui.input({ key: 'message-local_one-0', text: 'Ship it' })

  expect(sent).toHaveLength(1)
  expect([...files.keys()].some(path => path.includes('/inbox/'))).toBe(false)
  await ui.unmount()
})

test('a session checks in and submits its waiting messages as the person, once', async ($, on) => {
  const submitted: unknown[] = []
  const files = new Map<string, string>()
  const clock = world(on, { submitted, files })
  files.set(`${BOARD_DIR}/inbox/uuid-self/2-b.txt`, 'second')
  files.set(`${BOARD_DIR}/inbox/uuid-self/1-a.txt`, 'first')
  files.set(`${BOARD_DIR}/inbox/uuid-other/1-c.txt`, 'not mine')
  await $.session.start(start)

  expect(files.get(`${BOARD_DIR}/alive/uuid-self`)).toBe(String(clock.now()))
  await clock.advance(3000)
  await clock.advance(3000)

  expect(submitted.map(e => (e as { text: string }).text)).toEqual(['first', 'second'])
  expect(JSON.stringify(submitted[0])).toContain('"asUser":true')
  expect([...files.keys()].filter(path => path.includes('/inbox/uuid-self/'))).toEqual([])
  expect(files.get(`${BOARD_DIR}/inbox/uuid-other/1-c.txt`)).toBe('not mine')
})

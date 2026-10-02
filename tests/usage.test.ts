import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Ledger, Tokens } from '../types'
import { chartCells, slotLabels, slotWidth } from '../hooks/chart'
import { modelName, money, span, tokenCount } from '../hooks/format'
import { DAY, HOUR, HOURLY_DAYS, RECENT_REPLIES, applyFile, bucketKey, emptyLedger, jobsFor, prune } from '../hooks/ledger'
import { costOf } from '../hooks/prices'
import { WEEK, entriesOf, seriesOf, totalsOf, weekAnchor, windowsOf } from '../hooks/report'
import { createReader } from '../hooks/scan'
import type { FileResult, Reply } from '../hooks/scan'

const AT = Date.parse('2026-10-02T01:00:00.000Z')

const grepLines = (index: number, done: number, replies: { start: number; model: string; id: string; tokens: Tokens; at?: number }[]) => [
  `## file ${index} 0`,
  ...replies.map(({ start, model, id, tokens, at }) =>
    [start, model, id, `req_${id}`, new Date(at ?? AT).toISOString(), tokens[0], tokens[1], tokens[2] + tokens[3], tokens[4], tokens[2], tokens[3]].join('\t'),
  ),
  `## done ${done}`,
]

const readAll = (text: string, chunk = 7): FileResult[] => {
  const results: FileResult[] = []
  const reader = createReader({ onFile: result => results.push(result), onFail: () => {} })
  for (let i = 0; i < text.length; i += chunk) reader.feed(text.slice(i, i + chunk))
  reader.end()
  return results
}

const reply = (id: string, tokens: Tokens, at = AT, model = 'claude-opus-5-5'): Reply => ({ key: `${id}|req_${id}`, model, at, tokens })

const job = (path: string, offset: number, length: number) => ({ path, offset, length })

describe('reading grep output', () => {
  test('turns each matched log line into one reply, however the output is chunked', async () => {
    const text = grepLines(0, 900, [
      { start: 0, model: 'claude-opus-5-5[1m]', id: 'msg_A', tokens: [2, 5, 0, 3, 4] },
      { start: 400, model: 'claude-fable-5-1', id: 'msg_B', tokens: [7, 11, 1, 0, 9] },
    ]).join('\n')
    for (const chunk of [1, 7, 64, text.length]) {
      const [result] = readAll(text, chunk)
      expect(result?.index).toBe(0)
      expect(result?.end).toBe(900)
      expect(result?.replies).toEqual([
        { key: 'msg_A|req_msg_A', model: 'claude-opus-5-5', at: AT, tokens: [2, 5, 0, 3, 4] },
        { key: 'msg_B|req_msg_B', model: 'claude-fable-5-1', at: AT, tokens: [7, 11, 1, 0, 9] },
      ])
    }
  })

  test('leaves a half-written last line for the next read', async () => {
    const text = grepLines(0, 400, [
      { start: 0, model: 'claude-opus-5-5', id: 'msg_A', tokens: [2, 5, 0, 3, 4] },
      { start: 400, model: 'claude-opus-5-5', id: 'msg_B', tokens: [7, 11, 1, 0, 9] },
    ]).join('\n')
    const [result] = readAll(text)
    expect(result?.replies.map(one => one.key)).toEqual(['msg_A|req_msg_A'])
  })

  test('reports a log it could not read without counting anything from it', async () => {
    const results: FileResult[] = []
    const failures: { index: number; message: string }[] = []
    const reader = createReader({ onFile: result => results.push(result), onFail: failure => failures.push(failure) })
    reader.feed(['## file 3 100', ['100', 'claude-opus-5-5', 'msg_A', 'req_A', '2026-10-02T01:00:00.000Z', '1', '1', '0', '0', '', ''].join('\t'), '## fail this log could not be read', ''].join('\n'))
    reader.end()
    expect(results).toEqual([])
    expect(failures).toEqual([{ index: 3, message: 'this log could not be read' }])
  })

  test('treats cache writes without a 5m/1h split as 5-minute writes', async () => {
    const text = ['## file 0 0', ['0', 'claude-opus-5', 'msg_C', 'req_C', '2026-10-02T01:00:00.000Z', '1', '3', '50', '2', '', ''].join('\t'), '## done 10', ''].join('\n')
    expect(readAll(text)[0]?.replies[0]?.tokens).toEqual([1, 3, 50, 0, 2])
  })
})

describe('the ledger', () => {
  const listed = (path: string, size: number) => ({ path, size, mtimeMs: AT })

  test('counts a reply once even when the log repeats it, and only the growth when it grows', async () => {
    const ledger = emptyLedger()
    const replies = [reply('msg_A', [1, 4, 0, 0, 10]), reply('msg_A', [1, 4, 0, 0, 10]), reply('msg_A', [1, 90, 0, 0, 10])]
    applyFile(ledger, job('/a', 0, 100), { index: 0, replies, end: 100 }, listed('/a', 100))
    expect(ledger.buckets[bucketKey(AT, 'claude-opus-5-5')]).toEqual([1, 90, 0, 0, 10])
  })

  test('remembers recent replies across reads of a growing log, but only a few', async () => {
    const ledger = emptyLedger()
    const first = Array.from({ length: RECENT_REPLIES + 5 }, (_, i) => reply(`msg_${i}`, [1, 1, 0, 0, 0]))
    applyFile(ledger, job('/a', 0, 100), { index: 0, replies: first, end: 100 }, listed('/a', 100))
    expect(Object.keys(ledger.cursors['/a']?.recent ?? {}).length).toBe(RECENT_REPLIES)
    const again = [reply(`msg_${RECENT_REPLIES + 4}`, [1, 1, 0, 0, 0]), reply('msg_new', [1, 1, 0, 0, 0])]
    applyFile(ledger, job('/a', 100, 50), { index: 0, replies: again, end: 150 }, listed('/a', 150))
    expect(ledger.buckets[bucketKey(AT, 'claude-opus-5-5')]).toEqual([RECENT_REPLIES + 6, RECENT_REPLIES + 6, 0, 0, 0])
    expect(ledger.cursors['/a']?.offset).toBe(150)
  })

  test('reads only what is new in each log', async () => {
    const ledger: Ledger = {
      buckets: {},
      cursors: {
        '/same': { size: 100, offset: 100, mtimeMs: AT, recent: {} },
        '/grown': { size: 100, offset: 100, mtimeMs: AT, recent: {} },
        '/half': { size: 100, offset: 80, mtimeMs: AT, recent: {} },
        '/replaced': { size: 100, offset: 100, mtimeMs: AT, recent: {} },
      },
    }
    const jobs = jobsFor(ledger, [listed('/same', 100), { ...listed('/grown', 160), mtimeMs: AT + 1 }, { ...listed('/half', 120), mtimeMs: AT + 1 }, { ...listed('/replaced', 40), mtimeMs: AT + 1 }, listed('/new', 30)])
    expect(jobs).toEqual([job('/grown', 100, 60), job('/half', 80, 40), job('/replaced', 0, 40), job('/new', 0, 30)])
  })

  test('forgets deleted logs, quiet logs\' recent replies and usage older than it keeps', async () => {
    const now = AT + 2 * DAY
    const ledger: Ledger = {
      buckets: { [bucketKey(AT, 'm')]: [1, 1, 1, 1, 1], [bucketKey(AT - 500 * DAY, 'm')]: [1, 1, 1, 1, 1] },
      cursors: {
        '/gone': { size: 1, offset: 1, mtimeMs: AT, recent: {} },
        '/quiet': { size: 1, offset: 1, mtimeMs: AT, recent: { k: [1, 1, 1, 1, 1] } },
      },
    }
    expect(prune(ledger, [listed('/quiet', 1)], now)).toBe(true)
    expect(Object.keys(ledger.cursors)).toEqual(['/quiet'])
    expect(ledger.cursors['/quiet']?.recent).toEqual({})
    expect(Object.keys(ledger.buckets)).toEqual([bucketKey(AT, 'm')])
    expect(prune(ledger, [listed('/quiet', 1)], now)).toBe(false)
  })

  test('folds usage older than two months into daily totals without changing them', async () => {
    const now = AT
    const old = AT - (HOURLY_DAYS + 5) * DAY
    const ledger: Ledger = {
      buckets: {
        [bucketKey(old, 'm')]: [1, 2, 3, 4, 5],
        [bucketKey(old + 3 * HOUR, 'm')]: [10, 20, 30, 40, 50],
        [bucketKey(AT - HOUR, 'm')]: [7, 7, 7, 7, 7],
      },
      cursors: {},
    }
    expect(prune(ledger, [], now)).toBe(true)
    const day = Math.floor(old / HOUR)
    expect(ledger.buckets).toEqual({
      [bucketKey((day - (day % 24)) * HOUR, 'm')]: [11, 22, 33, 44, 55],
      [bucketKey(AT - HOUR, 'm')]: [7, 7, 7, 7, 7],
    })
    expect(prune(ledger, [], now)).toBe(false)
  })

  test('keeps a year of hourly usage for several models well inside the 4 MiB store', async () => {
    const ledger = emptyLedger()
    const models = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5']
    for (let hour = 0; hour < 365 * 24; hour += 1) {
      for (const model of models) ledger.buckets[bucketKey(AT - hour * HOUR, model)] = [123456, 12345, 1234567, 123456, 123456789]
    }
    for (let i = 0; i < 400; i += 1) {
      const recent = Object.fromEntries(Array.from({ length: i < 20 ? RECENT_REPLIES : 0 }, (_, k) => [`msg_01234567890123456789${k}|req_01234567890123456789${k}`, [1, 2, 3, 4, 5] as Tokens]))
      ledger.cursors[`/Users/someone/.claude/projects/-Users-someone-Dev-Some-Project/${i}-0123-4567-89ab-cdef01234567.jsonl`] = { size: 123456789, offset: 123456789, mtimeMs: AT, recent }
    }
    expect(JSON.stringify(ledger).length < 3 * 1024 * 1024).toBe(true)
  })
})

describe('the report', () => {
  test('prices tokens by model and type', async () => {
    expect(costOf('claude-opus-5-5', [1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000])).toBe(4 + 20 + 5 + 8 + 0.2)
    expect(costOf('claude-haiku-4-5-20251001', [1_000_000, 0, 0, 0, 0])).toBe(1)
    expect(costOf('claude-unknown-9', [1, 1, 1, 1, 1])).toBe(null)
  })

  test('totals a window by model and token type, keeping unpriced models apart', async () => {
    const ledger: Ledger = {
      buckets: {
        [bucketKey(AT, 'claude-opus-5-5')]: [1_000_000, 0, 0, 0, 0],
        [bucketKey(AT + HOUR, 'claude-fable-5-1')]: [0, 1_000_000, 0, 0, 0],
        [bucketKey(AT, 'claude-unknown-9')]: [5, 0, 0, 0, 0],
        [bucketKey(AT + 2 * DAY, 'claude-opus-5-5')]: [9_000_000, 0, 0, 0, 0],
      },
      cursors: {},
    }
    const totals = totalsOf(entriesOf(ledger), { start: AT, end: AT + DAY })
    expect(totals.cost).toBe(54)
    expect(totals.tokens).toBe(2_000_005)
    expect(totals.unpricedTokens).toBe(5)
    expect(totals.models.map(model => model.model)).toEqual(['claude-fable-5-1', 'claude-opus-5-5', 'claude-unknown-9'])
    expect(seriesOf(entriesOf(ledger), AT, DAY, 3).tokens).toEqual([2_000_005, 0, 9_000_000])
  })

  test('lines weeks up with the 7-day reset, then the last known one, then Monday', async () => {
    const reset = AT + 3 * DAY
    expect(weekAnchor(reset, null, AT)).toBe(reset)
    expect(weekAnchor(null, reset - 2 * WEEK, AT)).toBe(reset)
    expect(new Date(weekAnchor(null, null, AT)).getDay()).toBe(1)
    expect(windowsOf(reset, 2)).toEqual([
      { start: reset - WEEK, end: reset },
      { start: reset - 2 * WEEK, end: reset - WEEK },
    ])
  })

  test('formats money, tokens, models and time the way the panel shows them', async () => {
    expect(money(1841.613)).toBe('$1,841.61')
    expect([999, 85_000_000, 124_000_000, 1_695_000_000].map(tokenCount)).toEqual(['999', '85M', '124M', '1.7B'])
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelName('claude-mythos-preview')).toBe('Mythos Preview')
    expect(span(2 * DAY + 20 * HOUR)).toBe('2d 20h')
  })

  test('draws bars that fill their slots and scale to the tallest', async () => {
    const slot = slotWidth(29, 7)
    expect(slot).toBe(4)
    const cells = chartCells({ columns: slot * 3, rows: 2, slot, values: [0, 5, 10], colors: [1, 2, 3] })
    expect(cells.length).toBe(Math.ceil((slot * 3 * 2 * 12) / 3) * 4)
    expect(slotLabels(['Sun', 'Mon'], 4)).toBe('Sun Mon ')
  })
})

const PANE = {
  plugin: 'usage-tracking',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'usage-tracking',
  props: { title: 'Usage', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 }, command: 'usage-tracking', args: '' } as const

type World = { failure?: string; failingLog?: number; isPaneOpen?: boolean; hasLimits?: boolean }

const world = (on: On, spawned: string[], { failure = '', failingLog, isPaneOpen = true, hasLimits = true }: World = {}) => {
  mock.env(on, { HOME: '/home/someone' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () =>
    hasLimits
      ? { value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 40, resetsAt: new Date(AT + 3 * DAY).toISOString() }] } }
      : { deny: 'no usage here' },
  )
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: isPaneOpen ? [{ id: 'usage-tracking', title: 'Usage', isShown: true, isFocused: true, isPlaced: true }] : [] }))
  on('fs.list', ($, e) => {
    if (e.path === '/home/someone/.claude/projects') return { value: [{ name: 'proj', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] }
    if (e.path === '/home/someone/.claude/projects/proj')
      return {
        value: [
          { name: 'a.jsonl', kind: 'file' as const, size: 900, mtimeMs: AT, isLink: false },
          ...(failingLog === undefined ? [] : [{ name: 'b.jsonl', kind: 'file' as const, size: 500, mtimeMs: AT, isLink: false }]),
        ],
      }
    return { deny: 'missing' }
  })
  on('fs.exists', () => ({ value: false }))
  on('process.spawn', async function* ($, e) {
    spawned.push(e.input ?? '')
    if (failure) yield { stream: 'stderr', text: failure }
    const jobs = (e.input ?? '').trim().split('\n')
    const text = jobs.flatMap((job, index) => {
      if (job.endsWith('/b.jsonl')) return [`## file ${index} 0`, '## fail this log could not be read']
      const [offset] = job.split('\t')
      if (offset !== '0') return [`## file ${index} ${offset}`, `## done ${offset}`]
      return grepLines(index, 900, [
        { start: 0, model: 'claude-opus-5-5', id: 'msg_A', tokens: [1_000_000, 1_000_000, 0, 0, 0] },
        { start: 300, model: 'claude-opus-5-5', id: 'msg_A', tokens: [1_000_000, 1_000_000, 0, 0, 0] },
      ])
    })
    yield { stream: 'stdout', text: `${text.join('\n')}\n` }
    return { value: { code: 0, signal: null } }
  })
}

describe('the panel', () => {
  test('opens from the command, reads the logs once and shows the week', async ($, on) => {
    const clock = mock.clock(on, { now: AT + HOUR })
    mock.store(on)
    const spawned: string[] = []
    world(on, spawned)

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run(RUN)
    await clock.settle()

    expect(spawned).toEqual(['0\t900\t/home/someone/.claude/projects/proj/a.jsonl\n'])
    const pane = await $.ui.mount(PANE)
    expect(await pane.find({ type: 'Text', text: /^Today\s+\$24\.00\s+2M$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Opus 5\.5\s+\$24\.00\s+2M\s+100%$/ })).toBeDefined()
    for (const detail of ['max $24.00 · today $24.00', 'max 2M · today 2M', 'max $24.00 · this week $24.00', 'max 2M · this week 2M']) {
      expect((await pane.findAll({ type: 'Text', text: `  ${detail}` })).length > 0).toBe(true)
    }
    expect((await pane.findAll({ type: 'Text', text: '  max $24.00 · today $24.00' })).length).toBe(2)
    const tips = await pane.findAll({ type: 'Text', text: /^ \w{3} \w{3} \d+ · \$24\.00 · 2M tokens $/ })
    expect(tips.length).toBe(4)
    expect(await pane.find({ type: 'Text', text: / – .* · \$24\.00 · 2M tokens $/ })).toBeDefined()

    await clock.advance(60_000)
    await clock.settle()
    expect(spawned.length).toBe(1)

    expect(await pane.find({ type: 'Text', text: /^This week$/ })).toBeDefined()
    await pane.press({ key: 'week-1' })
    expect(await pane.find({ type: 'Text', text: /^Last week$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '  max $0.00' })).toBeDefined()
    expect((await pane.findAll({ type: 'Text', text: '  max $24.00 · today $24.00' })).length).toBe(1)
    await pane.unmount()
  })

  test('shows a scan problem and reads the same logs again next time instead of skipping them', async ($, on) => {
    const clock = mock.clock(on, { now: AT + HOUR })
    mock.store(on)
    const spawned: string[] = []
    world(on, spawned, { failure: 'sh: awk: command not found\n' })

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run(RUN)
    await clock.settle()

    const pane = await $.ui.mount(PANE)
    expect(await pane.find({ type: 'Text', text: /Couldn't read the logs: sh: awk: command not found/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Today\s+\$0\.00\s+0$/ })).toBeDefined()

    await clock.advance(60_000)
    await clock.settle()
    expect(spawned.length).toBe(2)
    expect(spawned[1]).toBe(spawned[0])
    await pane.unmount()
  })

  test('counts the logs it can read, flags the one it cannot, and retries only that one', async ($, on) => {
    const clock = mock.clock(on, { now: AT + HOUR })
    mock.store(on)
    const spawned: string[] = []
    world(on, spawned, { failingLog: 1 })

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run(RUN)
    await clock.settle()

    const pane = await $.ui.mount(PANE)
    expect(await pane.find({ type: 'Text', text: /^Today\s+\$24\.00\s+2M$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Couldn't read 1 log \(this log could not be read\); trying again next refresh/ })).toBeDefined()

    await clock.advance(60_000)
    await clock.settle()
    expect(spawned[1]).toBe('0\t500\t/home/someone/.claude/projects/proj/b.jsonl\n')
    await pane.unmount()
  })

  test('opens the same panel from the short /ut command', async ($, on) => {
    const clock = mock.clock(on, { now: AT + HOUR })
    mock.store(on)
    const spawned: string[] = []
    world(on, spawned)

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run({ ...RUN, command: 'ut' })
    await clock.settle()

    expect(spawned.length).toBe(1)
    const pane = await $.ui.mount(PANE)
    expect(await pane.find({ type: 'Text', text: /^Today\s+\$24\.00\s+2M$/ })).toBeDefined()
    await pane.unmount()
  })

  test('keeps scanning when the saved reset time cannot be read, and retries a failed save', async ($, on) => {
    const clock = mock.clock(on, { now: AT + HOUR })
    const spawned: string[] = []
    const saved: string[] = []
    let isStoreFull = true
    const store = new Map<string, unknown>()
    on('store.get', ($, e) => (e.key === 'anchor' ? { deny: 'store unavailable' } : { value: store.get(e.key) }))
    on('store.set', ($, e) => {
      if (e.key === 'ledger-v2') saved.push(e.key)
      if (e.key === 'ledger-v2' && isStoreFull) return { deny: 'store is full' }
      store.set(e.key, e.value)
      return { value: undefined }
    })
    on('store.delete', ($, e) => {
      store.delete(e.key)
      return { value: undefined }
    })
    world(on, spawned)

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run(RUN)
    await clock.settle()

    expect(spawned.length).toBe(1)
    const pane = await $.ui.mount(PANE)
    expect(await pane.find({ type: 'Text', text: /^Today\s+\$24\.00\s+2M$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Couldn't save usage history/ })).toBeDefined()

    isStoreFull = false
    await clock.advance(60_000)
    await clock.settle()
    expect(saved.length).toBe(2)
    expect(await pane.find({ type: 'Text', text: /^Updated / })).toBeDefined()
    await pane.unmount()
  })

  test('uses compact tooltips on a narrow panel', async ($, on) => {
    const clock = mock.clock(on, { now: AT + HOUR })
    mock.store(on)
    world(on, [])

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run(RUN)
    await clock.settle()

    const pane = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 44 } })
    expect(await pane.find({ type: 'Text', text: /^ \w{3} \w{3} \d+ \$24\.00 2M $/ })).toBeDefined()
    await pane.unmount()
  })

  test('stops refreshing when the panel is gone and copes without a 7-day limit', async ($, on) => {
    const clock = mock.clock(on, { now: AT + HOUR })
    mock.store(on)
    const spawned: string[] = []
    world(on, spawned, { isPaneOpen: false, hasLimits: false })

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run(RUN)
    await clock.settle()
    await clock.advance(3 * 60_000)
    await clock.settle()
    expect(spawned.length).toBe(1)

    const pane = await $.ui.mount(PANE)
    expect(await pane.find({ type: 'Text', text: /^Updated / })).toBeDefined()
    await pane.unmount()
  })
})

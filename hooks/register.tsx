import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ledger, ScanStatus } from '../types'
import { chartCells, slotLabels, slotWidth } from './chart'
import { agoText, dateText, dateTimeText, fit, modelName, money, shortDateText, span, tokenCount, weekdayText } from './format'
import { DAY, applyFile, emptyLedger, isLedger, jobsFor, prune } from './ledger'
import type { Listed } from './ledger'
import { WEEK, entriesOf, seriesOf, startOfDay, totalsOf, weekAnchor, windowsOf } from './report'
import type { Entry, Totals, Window } from './report'
import { SCAN_ARGV, createReader, jobLines } from './scan'
import type { FileFailure } from './scan'

const IDLE: ScanStatus = { isScanning: false, done: 0, total: 0, updatedAt: null, error: null }

const status = atom({ plugin: 'usage-tracking', key: 'status' } as const, IDLE)
const revision = atom({ plugin: 'usage-tracking', key: 'revision' } as const, 0)
const week = atom({ plugin: 'usage-tracking', key: 'week' } as const, 0)
const anchor = atom({ plugin: 'usage-tracking', key: 'anchor' } as const, null)

const COMMAND = 'usage-tracking'
const SHORT_COMMAND = 'ut'
const PANE = 'usage-tracking'
const LEDGER_KEY = 'ledger-v2'
const OLD_LEDGER_KEYS = ['ledger']
const ANCHOR_KEY = 'anchor'
const REFRESH_MS = 60_000
const PROGRESS_EVERY = 10
const WEEKS_SHOWN = 8
const MONTH_DAYS = 30
const CHART_ROWS = 4
const MAX_COLUMNS = 90
const PANE_COLUMNS = 60
const PANE_ROWS = 48
const ORANGE = 0xd97757
const PEACH = 0xf0b49a
const BLUE = 0x6a9bcc
const SKY = 0xa9c8e8
const ACCENT = '#d97757'
const WEEK_NAMES = ['This week', 'Last week']

let ledger: Promise<Ledger> | undefined
let scanning: Promise<void> | undefined
let refresher: { cancel: () => void } | undefined
let entriesCache: { revision: number; entries: Entry[] } | undefined
let isUnsaved = false

const weekName = (ago: number): string => WEEK_NAMES[ago] ?? `${ago} weeks ago`

const entriesFor = (book: Ledger, current: number): Entry[] => {
  if (entriesCache?.revision !== current) entriesCache = { revision: current, entries: entriesOf(book) }
  return entriesCache.entries
}

async function readLedger($: EngineInterface): Promise<Ledger> {
  for (const key of OLD_LEDGER_KEYS) await $.store.delete(key)
  const saved = await $.store.get(LEDGER_KEY)
  return isLedger(saved) ? saved : emptyLedger()
}

async function loadLedger($: EngineInterface): Promise<Ledger> {
  ledger ??= readLedger($)
  return ledger
}

async function projectsRoot($: EngineInterface): Promise<string> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = await $.env.get('HOME')
  return `${config ?? `${home}/.claude`}/projects`
}

const logsIn = (folder: string, entries: readonly { name: string; kind: string; size: number; mtimeMs: number }[]): Listed[] =>
  entries
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl'))
    .map(entry => ({ path: `${folder}/${entry.name}`, size: entry.size, mtimeMs: entry.mtimeMs }))

async function listLogs($: EngineInterface): Promise<{ logs: Listed[]; isComplete: boolean }> {
  const root = await projectsRoot($)
  const logs: Listed[] = []
  let isComplete = true
  const projects = await $.fs.list(root).catch(() => null)
  if (!projects) return { logs, isComplete: false }
  for (const project of projects.filter(entry => entry.kind === 'dir')) {
    const folder = `${root}/${project.name}`
    const entries = await $.fs.list(folder).catch(() => null)
    if (!entries) {
      isComplete = false
      continue
    }
    logs.push(...logsIn(folder, entries))
    for (const session of entries.filter(entry => entry.kind === 'dir')) {
      const subagents = `${folder}/${session.name}/subagents`
      if (!(await $.fs.exists(subagents))) continue
      const found = await $.fs.list(subagents).catch(() => null)
      if (found) logs.push(...logsIn(subagents, found))
      else isComplete = false
    }
  }
  return { logs, isComplete }
}

async function liveReset($: EngineInterface): Promise<number | null> {
  try {
    const { rateLimits } = await $.session.usage()
    const resetsAt = rateLimits.find(limit => limit.kind === 'seven_day')?.resetsAt
    const live = resetsAt ? Date.parse(resetsAt) : Number.NaN
    return Number.isNaN(live) ? null : live
  } catch {
    return null
  }
}

async function refreshAnchor($: EngineInterface, now: number) {
  const live = await liveReset($)
  const saved = await $.store.get(ANCHOR_KEY)
  const stored = typeof saved === 'number' ? saved : null
  const next = weekAnchor(live, stored, now)
  if (live !== null && live > now && live !== stored) await $.store.set(ANCHOR_KEY, live)
  await update($, anchor, current => (current === next ? current : next))
}

async function setStatus($: EngineInterface, patch: Partial<ScanStatus>) {
  await update($, status, current => ({ ...current, ...patch }))
}

type Reading = { read: number; failures: FileFailure[] }

async function readLogs($: EngineInterface, book: Ledger, logs: readonly Listed[]): Promise<Reading> {
  const jobs = jobsFor(book, logs)
  const failures: FileFailure[] = []
  if (jobs.length === 0) return { read: 0, failures }
  const listedBy = new Map(logs.map(log => [log.path, log]))
  let done = 0
  let shown = 0
  await setStatus($, { isScanning: true, done, total: jobs.length, error: null })
  const reader = createReader({
    onFile: result => {
      const job = jobs[result.index]
      const listed = job && listedBy.get(job.path)
      if (job && listed) applyFile(book, job, result, listed)
      done += 1
    },
    onFail: failure => {
      failures.push(failure)
      done += 1
    },
  })
  const child = $.process.spawn({ argv: SCAN_ARGV, input: jobLines(jobs) })
  let problems = ''
  for await (const { stream, text } of child) {
    if (stream === 'stderr') {
      problems += text
      continue
    }
    reader.feed(text)
    if (done - shown >= PROGRESS_EVERY) {
      shown = done
      await setStatus($, { done })
      await update($, revision, current => current + 1)
    }
  }
  reader.end()
  const { code } = await child.result
  if (code !== 0 || problems.trim() !== '') throw new Error(problems.trim().split('\n')[0] || `the log reader stopped with code ${code}`)
  return { read: jobs.length - failures.length, failures }
}

const failureText = (failures: readonly FileFailure[]): string | null => {
  const [first] = failures
  if (!first) return null
  return `Couldn't read ${failures.length === 1 ? '1 log' : `${failures.length} logs`} (${first.message}); trying again next refresh`
}

async function saveLedger($: EngineInterface, book: Ledger): Promise<string | null> {
  try {
    await $.store.set(LEDGER_KEY, book)
    return null
  } catch (error) {
    return `Couldn't save usage history: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function scanOnce($: EngineInterface) {
  const now = await $.clock.now()
  await refreshAnchor($, now).catch(() => null)
  try {
    const book = await loadLedger($)
    const { logs, isComplete } = await listLogs($)
    const { read, failures } = await readLogs($, book, logs)
    const isPruned = isComplete && prune(book, logs, now)
    const isChanged = read > 0 || isPruned
    const saveProblem = isChanged || isUnsaved ? await saveLedger($, book) : null
    isUnsaved = saveProblem !== null
    if (isChanged) await update($, revision, current => current + 1)
    await setStatus($, { isScanning: false, done: read, total: read, updatedAt: await $.clock.now(), error: saveProblem ?? failureText(failures) })
  } catch (error) {
    ledger = undefined
    entriesCache = undefined
    await update($, revision, current => current + 1)
    await setStatus($, { isScanning: false, error: `Couldn't read the logs: ${error instanceof Error ? error.message : String(error)}` })
  }
}

async function scan($: EngineInterface) {
  scanning ??= scanOnce($).finally(() => {
    scanning = undefined
  })
  return scanning
}

async function refreshIfOpen($: EngineInterface) {
  const panes = await $.ui.panes()
  if (panes.some(pane => pane.id === PANE)) await scan($)
  else stopRefreshing()
}

async function openPanel($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: 'Usage', focus: true, closeOnEscape: true, columns: PANE_COLUMNS, rows: PANE_ROWS })
  startRefreshing($)
  void scan($)
  return opened.isPlaced ? {} : { text: 'Widen the terminal to see the usage panel.' }
}

function startRefreshing($: EngineInterface) {
  refresher ??= $.clock.every(REFRESH_MS, () => void refreshIfOpen($))
}

const stopRefreshing = () => {
  refresher?.cancel()
  refresher = undefined
}

async function pickWeek($: EngineInterface, value: string) {
  const ago = Number(value)
  if (Number.isInteger(ago)) await update($, week, () => ago)
}

const sliceLabels = (start: number, days: number): string[] =>
  Array.from({ length: days }, (_, i) => weekdayText(start + i * DAY))

const peakText = (max: string, label: string, now: string | null): string => (now === null ? `max ${max}` : `max ${max} · ${label} ${now}`)

const dayLabel = (start: number): string => `${weekdayText(start)} ${dateText(start)}`

const COMPACT_TIPS_BELOW = 40

const tipText = (label: string, cost: number, tokens: number, width: number): string =>
  width < COMPACT_TIPS_BELOW ? `${label} ${money(cost)} ${tokenCount(tokens)}` : `${label} · ${money(cost)} · ${tokenCount(tokens)} tokens`

const shareText = (part: number, whole: number): string => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '')

const summaryRow = (label: string, totals: Totals): string =>
  `${label.padEnd(13)}${money(totals.cost).padStart(11)}  ${tokenCount(totals.tokens).padStart(6)}`

const edgeLabels = (left: string, right: string, columns: number): string =>
  `${left}${right.padStart(Math.max(right.length + 1, columns - left.length))}`

const weekLabel = (window: Window, slot: number): string => (slot > dateText(window.start).length ? dateText(window.start) : shortDateText(window.start))

const weekNumbers = (window: Window, totals: Totals): string =>
  `${`${dateText(window.start)} – ${dateText(window.end)}`.padEnd(17)}${money(totals.cost).padStart(11)}  ${tokenCount(totals.tokens).padStart(5)}`

const weekOption = (window: Window, ago: number, totals: Totals, columns: number): string => {
  const named = `${weekName(ago).padEnd(12)}${weekNumbers(window, totals)}`
  return named.length <= columns ? named : weekNumbers(window, totals)
}

const statusText = (state: ScanStatus, now: number, isEmpty: boolean): string => {
  if (state.error) return state.error
  if (state.isScanning) return `Reading Claude Code logs… ${state.done} of ${state.total}`
  if (state.updatedAt === null) return isEmpty ? 'Reading Claude Code logs…' : 'Checking for new usage…'
  return `Updated ${agoText(now - state.updatedAt)}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Show your Claude Code cost and token usage by day and week', immediate: true })
    await $.command.register({ name: SHORT_COMMAND, description: 'Short for /usage-tracking', immediate: true })

    return next(e)
  })

  on('command.run', { command: COMMAND }, $ => openPanel($))

  on('command.run', { command: SHORT_COMMAND }, $ => openPanel($))

  on('ui.close', ($, e, next) => {
    if (e.id === PANE) stopRefreshing()

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    startRefreshing($)
    const book = await loadLedger($)
    const state = await read($, status)
    const current = await read($, revision)
    const chosen = await read($, week)
    const anchorAt = await read($, anchor)
    const now = await $.clock.now()
    const entries = entriesFor(book, current)
    const resetAt = weekAnchor(null, anchorAt, now)
    const weeks = windowsOf(resetAt, WEEKS_SHOWN).map(window => ({ window, totals: totalsOf(entries, window) }))
    const currentWindow = { start: resetAt - WEEK, end: resetAt }
    const latest = weeks[0] ?? { window: currentWindow, totals: totalsOf(entries, currentWindow) }
    const monthStart = startOfDay(now) - (MONTH_DAYS - 1) * DAY
    const today = totalsOf(entries, { start: startOfDay(now), end: now + DAY })
    const month = totalsOf(entries, { start: monthStart, end: now + DAY })
    const picked = Math.min(Math.max(0, chosen), WEEKS_SHOWN - 1)
    const { window: pickedWindow, totals: detail } = weeks[picked] ?? latest
    const isEmpty = entries.length === 0
    const columns = Math.max(24, Math.min(e.props.bodyColumns, MAX_COLUMNS))
    const { Box, Text } = $.ui.resolve(e)

    const thisWeek = summaryRow('This week', latest.totals)
    const resets = `resets in ${span(resetAt - now)}`
    const header = (
      <Box flexDirection="column">
        <Text>{summaryRow('Today', today)}</Text>
        {thisWeek.length + resets.length + 2 <= columns ? (
          <Box flexDirection="row">
            <Text>{thisWeek}</Text>
            <Text dimColor>{`  ${resets}`}</Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text>{thisWeek}</Text>
            <Text dimColor>{`${' '.repeat(13)}${resets}`}</Text>
          </Box>
        )}
        <Text>{summaryRow(`Last ${MONTH_DAYS} days`, month)}</Text>
      </Box>
    )
    const footer = (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>{statusText(state, now, isEmpty)}</Text>
        <Text dimColor>Estimated from local logs at API prices.</Text>
        <Text dimColor>Unlogged calls, like compacting, aren't counted.</Text>
      </Box>
    )

    if (e.surface !== 'terminal') {
      return (
        <Box flexDirection="column">
          {header}
          {weeks.map(({ window, totals }, ago) => (
            <Text>{weekOption(window, ago, totals, columns)}</Text>
          ))}
          {footer}
        </Box>
      )
    }

    const { Button, Raster } = $.ui.resolve(e)
    const monthSlot = slotWidth(columns, MONTH_DAYS)
    const monthSeries = seriesOf(entries, monthStart, DAY, MONTH_DAYS)
    const weekSlot = slotWidth(columns, WEEKS_SHOWN)
    const oldestFirst = [...weeks].reverse()
    const weeklyCost = oldestFirst.map(({ totals }) => totals.cost)
    const weeklyTokens = oldestFirst.map(({ totals }) => totals.tokens)
    const pickedColumn = WEEKS_SHOWN - 1 - picked
    const weekLabels = slotLabels(oldestFirst.map(({ window }) => weekLabel(window, weekSlot)), weekSlot)
    const daySlot = slotWidth(columns, 7)
    const weekSeries = seriesOf(entries, pickedWindow.start, DAY, 7)
    const todayIndex = Math.floor((now - pickedWindow.start) / DAY)
    const tint = (base: number, bright: number) => (_: number, i: number) => (i === todayIndex ? bright : base)
    const titled = (title: string, detail: string) => (
      <Box flexDirection={title.length + detail.length + 2 <= columns ? 'row' : 'column'} marginTop={1}>
        <Text bold>{title}</Text>
        <Text dimColor>{detail ? `  ${detail}` : ''}</Text>
      </Box>
    )
    const isPickedNow = todayIndex >= 0 && todayIndex < 7
    const barChart = (name: string, values: number[], slot: number, colors: number[], tips: string[]) => {
      const max = Math.max(0, ...values)
      const width = slot * values.length
      return (
        <Box flexDirection="row">
          {values.map((value, i) => {
            const tip = ` ${tips[i] ?? ''} `.slice(0, width)
            const left = Math.max(-i * slot, Math.min(0, width - i * slot - tip.length))
            return (
              <Box key={`${name}-${i}`}>
                <Raster
                  key={`${name}-bar-${i}`}
                  columns={slot}
                  rows={CHART_ROWS}
                  cells={chartCells({ columns: slot, rows: CHART_ROWS, slot, values: [value], colors: [colors[i] ?? ORANGE], max })}
                />
                <Box position="absolute" top={-1} left={left} display="none" hover={{ display: 'flex' }}>
                  <Text inverse>{tip}</Text>
                </Box>
              </Box>
            )
          })}
        </Box>
      )
    }
    const monthTips = monthSeries.cost.map((cost, i) => tipText(dayLabel(monthStart + i * DAY), cost, monthSeries.tokens[i] ?? 0, monthSlot * MONTH_DAYS))
    const weeklyTips = oldestFirst.map(({ window, totals }) => tipText(`${dateText(window.start)} – ${dateText(window.end)}`, totals.cost, totals.tokens, weekSlot * WEEKS_SHOWN))
    const dayTips = weekSeries.cost.map((cost, i) => {
      const start = pickedWindow.start + i * DAY
      return start > now ? `${dayLabel(start)} · not yet` : tipText(dayLabel(start), cost, weekSeries.tokens[i] ?? 0, daySlot * 7)
    })
    const typeRows: [string, number, number][] = [
      ['Input', detail.parts[0], detail.partCosts[0]],
      ['Output', detail.parts[1], detail.partCosts[1]],
      ['Cache write', detail.parts[2] + detail.parts[3], detail.partCosts[2] + detail.partCosts[3]],
      ['Cache read', detail.parts[4], detail.partCosts[4]],
    ]

    return (
      <Box flexDirection="column">
        {header}
        {titled(`Cost per day, last ${MONTH_DAYS} days`, peakText(money(Math.max(0, ...monthSeries.cost)), 'today', money(monthSeries.cost[MONTH_DAYS - 1] ?? 0)))}
        {barChart('month-cost', monthSeries.cost, monthSlot, monthSeries.cost.map((_, i) => (i === MONTH_DAYS - 1 ? PEACH : ORANGE)), monthTips)}
        <Text dimColor>{edgeLabels(dateText(monthStart), 'today', monthSlot * MONTH_DAYS)}</Text>
        {titled(`Tokens per day, last ${MONTH_DAYS} days`, peakText(tokenCount(Math.max(0, ...monthSeries.tokens)), 'today', tokenCount(monthSeries.tokens[MONTH_DAYS - 1] ?? 0)))}
        {barChart('month-tokens', monthSeries.tokens, monthSlot, monthSeries.tokens.map((_, i) => (i === MONTH_DAYS - 1 ? SKY : BLUE)), monthTips)}
        <Text dimColor>{edgeLabels(dateText(monthStart), 'today', monthSlot * MONTH_DAYS)}</Text>
        {titled('Cost per week', peakText(money(Math.max(0, ...weeklyCost)), 'this week', money(latest.totals.cost)))}
        {barChart('weekly-cost', weeklyCost, weekSlot, weeklyCost.map((_, i) => (i === pickedColumn ? PEACH : ORANGE)), weeklyTips)}
        <Text dimColor>{weekLabels}</Text>
        {titled('Tokens per week', peakText(tokenCount(Math.max(0, ...weeklyTokens)), 'this week', tokenCount(latest.totals.tokens)))}
        {barChart('weekly-tokens', weeklyTokens, weekSlot, weeklyTokens.map((_, i) => (i === pickedColumn ? SKY : BLUE)), weeklyTips)}
        <Text dimColor>{weekLabels}</Text>
        {titled('Weeks', `press 1–${WEEKS_SHOWN} for details`)}
        {weeks.map(({ window, totals }, ago) => (
          <Button
            key={`week-${ago}`}
            label={`${ago === picked ? '▸' : ' '} ${fit(weekOption(window, ago, totals, columns - 5), columns - 5).trimEnd()}`}
            hotkey={String(ago + 1)}
            plain
            dimColor={ago !== picked}
            onPress={() => void pickWeek($, String(ago))}
          />
        ))}
        {titled(weekName(picked), `${dateTimeText(pickedWindow.start)} → ${dateTimeText(pickedWindow.end)}`)}
        <Text>{`${money(detail.cost)} · ${tokenCount(detail.tokens)} tokens`}</Text>
        {titled('Cost per day', peakText(money(Math.max(0, ...weekSeries.cost)), 'today', isPickedNow ? money(weekSeries.cost[todayIndex] ?? 0) : null))}
        {barChart('day-cost', weekSeries.cost, daySlot, weekSeries.cost.map(tint(ORANGE, PEACH)), dayTips)}
        <Text dimColor>{slotLabels(sliceLabels(pickedWindow.start, 7), daySlot)}</Text>
        {titled('Tokens per day', peakText(tokenCount(Math.max(0, ...weekSeries.tokens)), 'today', isPickedNow ? tokenCount(weekSeries.tokens[todayIndex] ?? 0) : null))}
        {barChart('day-tokens', weekSeries.tokens, daySlot, weekSeries.tokens.map(tint(BLUE, SKY)), dayTips)}
        <Text dimColor>{slotLabels(sliceLabels(pickedWindow.start, 7), daySlot)}</Text>
        {titled('By model', '')}
        {detail.models.length === 0 ? (
          <Text dimColor>No usage this week.</Text>
        ) : (
          detail.models.map(model => (
            <Text>
              {`${fit(modelName(model.model), 14)}${money(model.cost).padStart(11)}  ${tokenCount(model.tokens).padStart(6)}  ${shareText(model.cost ?? 0, detail.cost).padStart(4)}`}
            </Text>
          ))
        )}
        {titled('Tokens by type', '')}
        {typeRows.map(([label, count, cost]) => (
          <Text>{`${label.padEnd(14)}${tokenCount(count).padStart(6)}  ${money(cost).padStart(11)}`}</Text>
        ))}
        {detail.unpricedTokens > 0 && (
          <Text color={ACCENT}>{`${tokenCount(detail.unpricedTokens)} tokens from models without a known price`}</Text>
        )}
        {footer}
      </Box>
    )
  })
}

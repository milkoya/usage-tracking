import type { Cursor, Ledger, Tokens } from '../types'
import type { FileResult, Job } from './scan'

export const HOUR = 3_600_000
export const DAY = 24 * HOUR
export const RECENT_REPLIES = 32
export const KEEP_DAYS = 400
export const HOURLY_DAYS = 60
export const QUIET_MS = DAY

export type Listed = { path: string; size: number; mtimeMs: number }

export const emptyLedger = (): Ledger => ({ buckets: {}, cursors: {} })

export const isLedger = (value: unknown): value is Ledger => {
  const ledger = value as Ledger | null
  return (
    typeof ledger === 'object' &&
    ledger !== null &&
    typeof ledger.buckets === 'object' &&
    ledger.buckets !== null &&
    typeof ledger.cursors === 'object' &&
    ledger.cursors !== null
  )
}

export const bucketKey = (at: number, model: string): string => `${Math.floor(at / HOUR)}|${model}`

export const parseBucketKey = (key: string): { hour: number; model: string } => {
  const bar = key.indexOf('|')
  return { hour: Number(key.slice(0, bar)), model: key.slice(bar + 1) }
}

const add = (into: Tokens, more: Tokens): Tokens => [
  into[0] + more[0],
  into[1] + more[1],
  into[2] + more[2],
  into[3] + more[3],
  into[4] + more[4],
]

const growth = (before: Tokens, after: Tokens): Tokens => [
  Math.max(0, after[0] - before[0]),
  Math.max(0, after[1] - before[1]),
  Math.max(0, after[2] - before[2]),
  Math.max(0, after[3] - before[3]),
  Math.max(0, after[4] - before[4]),
]

const most = (a: Tokens, b: Tokens): Tokens => [
  Math.max(a[0], b[0]),
  Math.max(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
  Math.max(a[4], b[4]),
]

const isZero = (tokens: Tokens): boolean => tokens.every(count => count === 0)

export const jobsFor = (ledger: Ledger, files: readonly Listed[]): Job[] =>
  files.flatMap(file => {
    const cursor = ledger.cursors[file.path]
    if (cursor && cursor.size === file.size && cursor.mtimeMs === file.mtimeMs) return []
    const offset = cursor && cursor.offset <= file.size ? cursor.offset : 0
    return file.size > offset ? [{ path: file.path, offset, length: file.size - offset }] : []
  })

const remember = (recent: Record<string, Tokens>, key: string, tokens: Tokens) => {
  delete recent[key]
  recent[key] = tokens
  const keys = Object.keys(recent)
  for (const old of keys.slice(0, Math.max(0, keys.length - RECENT_REPLIES))) delete recent[old]
}

export const applyFile = (ledger: Ledger, job: Job, result: FileResult, listed: Listed) => {
  const before = ledger.cursors[job.path]
  const recent = job.offset === 0 ? {} : { ...before?.recent }
  for (const reply of result.replies) {
    const seen = recent[reply.key]
    const counted = seen ? growth(seen, reply.tokens) : reply.tokens
    remember(recent, reply.key, seen ? most(seen, reply.tokens) : reply.tokens)
    if (isZero(counted)) continue
    const key = bucketKey(reply.at, reply.model)
    ledger.buckets[key] = add(ledger.buckets[key] ?? [0, 0, 0, 0, 0], counted)
  }
  const cursor: Cursor = { size: listed.size, offset: result.end, mtimeMs: listed.mtimeMs, recent }
  ledger.cursors[job.path] = cursor
}

export const prune = (ledger: Ledger, files: readonly Listed[], now: number): boolean => {
  const present = new Set(files.map(file => file.path))
  let isChanged = false
  for (const [path, cursor] of Object.entries(ledger.cursors)) {
    if (!present.has(path)) {
      delete ledger.cursors[path]
      isChanged = true
    } else if (now - cursor.mtimeMs > QUIET_MS && Object.keys(cursor.recent).length > 0) {
      cursor.recent = {}
      isChanged = true
    }
  }
  const oldest = Math.floor((now - KEEP_DAYS * DAY) / HOUR)
  const hourly = Math.floor((now - HOURLY_DAYS * DAY) / HOUR)
  for (const [key, tokens] of Object.entries(ledger.buckets)) {
    const { hour, model } = parseBucketKey(key)
    const isExpired = hour < oldest
    const isFoldable = hour < hourly && hour % 24 !== 0
    if (!isExpired && !isFoldable) continue
    delete ledger.buckets[key]
    isChanged = true
    if (isExpired) continue
    const day = bucketKey((hour - (hour % 24)) * HOUR, model)
    ledger.buckets[day] = add(ledger.buckets[day] ?? [0, 0, 0, 0, 0], tokens)
  }
  return isChanged
}

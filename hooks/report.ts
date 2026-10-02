import type { Ledger, Tokens } from '../types'
import { DAY, HOUR, parseBucketKey } from './ledger'
import { costsOf } from './prices'

export const WEEK = 7 * DAY

export type Entry = { at: number; model: string; tokens: Tokens; costs: Tokens | null }

export type ModelTotal = { model: string; cost: number | null; tokens: number }

export type Totals = { cost: number; tokens: number; parts: Tokens; partCosts: Tokens; unpricedTokens: number; models: ModelTotal[] }

export type Window = { start: number; end: number }

export type Series = { cost: number[]; tokens: number[] }

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

export const entriesOf = (ledger: Ledger): Entry[] =>
  Object.entries(ledger.buckets).map(([key, tokens]) => {
    const { hour, model } = parseBucketKey(key)
    return { at: hour * HOUR, model, tokens, costs: costsOf(model, tokens) }
  })

const plus = (a: Tokens, b: Tokens): Tokens => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3], a[4] + b[4]]

export const totalsOf = (entries: readonly Entry[], { start, end }: Window): Totals => {
  let parts: Tokens = [0, 0, 0, 0, 0]
  let partCosts: Tokens = [0, 0, 0, 0, 0]
  const models = new Map<string, ModelTotal>()
  let unpricedTokens = 0
  for (const entry of entries) {
    if (entry.at < start || entry.at >= end) continue
    const tokens = sum(entry.tokens)
    const cost = entry.costs ? sum(entry.costs) : null
    parts = plus(parts, entry.tokens)
    if (entry.costs) partCosts = plus(partCosts, entry.costs)
    if (cost === null) unpricedTokens += tokens
    const model = models.get(entry.model) ?? { model: entry.model, cost: cost === null ? null : 0, tokens: 0 }
    models.set(entry.model, { model: entry.model, cost: model.cost === null || cost === null ? null : model.cost + cost, tokens: model.tokens + tokens })
  }
  return {
    cost: sum(partCosts),
    tokens: sum(parts),
    parts,
    partCosts,
    unpricedTokens,
    models: [...models.values()].sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.tokens - a.tokens),
  }
}

export const seriesOf = (entries: readonly Entry[], start: number, step: number, count: number): Series => {
  const cost = Array.from({ length: count }, () => 0)
  const tokens = Array.from({ length: count }, () => 0)
  for (const entry of entries) {
    const slot = Math.floor((entry.at - start) / step)
    if (slot < 0 || slot >= count) continue
    cost[slot] = (cost[slot] ?? 0) + (entry.costs ? sum(entry.costs) : 0)
    tokens[slot] = (tokens[slot] ?? 0) + sum(entry.tokens)
  }
  return { cost, tokens }
}

const nextMonday = (now: number): number => {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  day.setDate(day.getDate() + ((8 - day.getDay()) % 7 || 7))
  return day.getTime()
}

export const weekAnchor = (live: number | null, stored: number | null, now: number): number => {
  if (live !== null && live > now) return live
  if (stored !== null) return stored > now ? stored : stored + Math.ceil((now - stored) / WEEK) * WEEK
  return nextMonday(now)
}

export const windowsOf = (anchor: number, count: number): Window[] =>
  Array.from({ length: count }, (_, ago) => ({ start: anchor - (ago + 1) * WEEK, end: anchor - ago * WEEK }))

export const startOfDay = (now: number): number => {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

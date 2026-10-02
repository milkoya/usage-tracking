import type { Tokens } from '../types'

type Rates = Tokens

const PER_MILLION: Readonly<Record<string, Rates>> = {
  'claude-fable-5': [10, 50, 12.5, 20, 1],
  'claude-fable-5-1': [10, 50, 12.5, 20, 0.25],
  'claude-haiku-4-5': [1, 5, 1.25, 2, 0.1],
  'claude-mythos-5': [10, 50, 12.5, 20, 1],
  'claude-mythos-5-1': [10, 50, 12.5, 20, 0.25],
  'claude-mythos-preview': [10, 50, 12.5, 20, 1],
  'claude-opus-4-5': [5, 25, 6.25, 10, 0.5],
  'claude-opus-4-6': [5, 25, 6.25, 10, 0.5],
  'claude-opus-4-7': [5, 25, 6.25, 10, 0.5],
  'claude-opus-4-8': [5, 25, 6.25, 10, 0.5],
  'claude-opus-5': [5, 25, 6.25, 10, 0.5],
  'claude-opus-5-5': [4, 20, 5, 8, 0.2],
  'claude-sonnet-4-5': [3, 15, 3.75, 6, 0.3],
  'claude-sonnet-4-6': [3, 15, 3.75, 6, 0.3],
  'claude-sonnet-5': [2, 10, 2.5, 4, 0.2],
  'claude-sonnet-5-5': [2, 10, 2.5, 4, 0.2],
}

const DATE_SUFFIX = /-\d{8}$/

export const ratesFor = (model: string): Rates | null => PER_MILLION[model] ?? PER_MILLION[model.replace(DATE_SUFFIX, '')] ?? null

export const costsOf = (model: string, tokens: Tokens): Tokens | null => {
  const rates = ratesFor(model)
  if (!rates) return null
  return [
    (tokens[0] * rates[0]) / 1_000_000,
    (tokens[1] * rates[1]) / 1_000_000,
    (tokens[2] * rates[2]) / 1_000_000,
    (tokens[3] * rates[3]) / 1_000_000,
    (tokens[4] * rates[4]) / 1_000_000,
  ]
}

export const costOf = (model: string, tokens: Tokens): number | null =>
  costsOf(model, tokens)?.reduce((sum, cost) => sum + cost, 0) ?? null

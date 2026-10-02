const BLANK = 0x20
const BAR_BASE = 0x2580
const DEFAULT = 0x01000000
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const toBase64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += ALPHABET[(n >> 18) & 63]
    out += ALPHABET[(n >> 12) & 63]
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? ALPHABET[n & 63] : '='
  }
  return out
}

export type Chart = { columns: number; rows: number; slot: number; values: readonly number[]; colors: readonly number[]; max?: number }

export const slotWidth = (columns: number, count: number): number => Math.max(1, Math.floor(columns / Math.max(1, count)))

const eighthsOf = (value: number, max: number, rows: number): number => {
  if (value <= 0 || max <= 0) return 0
  return Math.max(1, Math.round((value / max) * rows * 8))
}

export const chartCells = ({ columns, rows, slot, values, colors, max = Math.max(0, ...values) }: Chart): string => {
  const heights = values.map(value => eighthsOf(value, max, rows))
  const barWidth = slot > 2 ? slot - 1 : slot
  const words = new Uint32Array(columns * rows * 3)
  for (let row = 0; row < rows; row += 1) {
    for (let x = 0; x < columns; x += 1) {
      const bar = Math.floor(x / slot)
      const isBar = bar < values.length && x % slot < barWidth
      const level = isBar ? Math.min(8, Math.max(0, (heights[bar] ?? 0) - (rows - 1 - row) * 8)) : 0
      const glyph = level === 0 ? BLANK : BAR_BASE + level
      words.set([glyph, level === 0 ? DEFAULT : (colors[bar] ?? DEFAULT), DEFAULT], (row * columns + x) * 3)
    }
  }
  return toBase64(new Uint8Array(words.buffer))
}

export const slotLabels = (labels: readonly string[], slot: number): string =>
  labels.map(label => (label.length < slot ? label.padEnd(slot) : `${label.slice(0, Math.max(1, slot - 1))} `)).join('')

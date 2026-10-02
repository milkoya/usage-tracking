const DOLLARS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short' })

const MINUTE = 60_000

export const money = (dollars: number | null): string => (dollars === null ? '—' : DOLLARS.format(dollars))

const scaled = (value: number, unit: string): string =>
  `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)}${unit}`

export const tokenCount = (count: number): string => {
  if (count >= 1e9) return scaled(count / 1e9, 'B')
  if (count >= 1e6) return scaled(count / 1e6, 'M')
  if (count >= 1e3) return scaled(count / 1e3, 'K')
  return String(Math.round(count))
}

export const dateText = (at: number): string => DATE.format(at)

export const shortDateText = (at: number): string => {
  const day = new Date(at)
  return `${day.getMonth() + 1}/${day.getDate()}`
}

export const dateTimeText = (at: number): string => `${DATE.format(at)} ${TIME.format(at)}`

export const weekdayText = (at: number): string => WEEKDAY.format(at)

export const span = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / MINUTE))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

export const agoText = (ms: number): string => (ms < MINUTE ? 'just now' : `${span(ms)} ago`)

const DATE_SUFFIX = /-\d{8}$/

export const modelName = (model: string): string => {
  const words = model.replace(/^claude-/, '').replace(DATE_SUFFIX, '').split('-')
  const name = words.filter(word => !/^\d+$/.test(word)).map(word => word.charAt(0).toUpperCase() + word.slice(1))
  const version = words.filter(word => /^\d+$/.test(word)).join('.')
  return [...name, version].filter(Boolean).join(' ')
}

export const fit = (text: string, columns: number): string =>
  text.length <= columns ? text.padEnd(columns) : `${text.slice(0, Math.max(0, columns - 1))}…`

import type { Tokens } from '../types'

export type Job = { path: string; offset: number; length: number }

export type Reply = { key: string; model: string; at: number; tokens: Tokens }

export type FileResult = { index: number; replies: Reply[]; end: number }

export type FileFailure = { index: number; message: string }

export const EXTRACT = `
function grab(text, name,    at, rest) {
  at = index(text, "\\"" name "\\":")
  if (at == 0) return ""
  rest = substr(text, at + length(name) + 3)
  if (substr(rest, 1, 1) == "\\"") { rest = substr(rest, 2); return substr(rest, 1, index(rest, "\\"") - 1) }
  match(rest, /^[0-9]+/)
  return RSTART ? substr(rest, 1, RLENGTH) : ""
}
function objectStart(text,    found, shift, rest) {
  found = 0
  shift = 0
  rest = text
  while (match(rest, /([[][{]|[}],[{])/)) {
    found = shift + RSTART + RLENGTH - 1
    shift += RSTART
    rest = substr(rest, RSTART + 1)
  }
  return found
}
function objectEnd(text) {
  return match(text, /[}](,[{]|[]])/) ? RSTART : 0
}
function row(start, model, id, request, time, usage) {
  return start "\\t" model "\\t" id "\\t" request "\\t" time "\\t" grab(usage, "input_tokens") "\\t" grab(usage, "output_tokens") "\\t" grab(usage, "cache_creation_input_tokens") "\\t" grab(usage, "cache_read_input_tokens") "\\t" grab(usage, "ephemeral_5m_input_tokens") "\\t" grab(usage, "ephemeral_1h_input_tokens")
}
{
  colon = index($0, ":")
  line = substr($0, colon + 1)
  message = index(line, "\\"message\\":{")
  at = index(line, "\\"usage\\":{")
  if (message == 0 || at < message) next
  header = substr(line, message, 400)
  model = grab(header, "model")
  id = grab(header, "id")
  if (model == "" || id == "") next
  usage = substr(line, at, 8000)
  tail = substr(line, at)
  start = base + substr($0, 1, colon - 1)
  request = grab(tail, "requestId")
  time = grab(tail, "timestamp")
  print row(start, model, id, request, time, usage)
  rest = tail
  helper = 0
  while ((marker = index(rest, "\\"type\\":\\"advisor_message\\"")) > 0) {
    from = objectStart(substr(rest, 1, marker))
    upto = objectEnd(substr(rest, marker))
    helper += 1
    if (from > 0 && upto > 0) {
      advisor = substr(rest, from, marker + upto - from)
      print row(start, grab(advisor, "model"), id "#advisor" helper, request, time, advisor)
    }
    rest = substr(rest, marker + 25)
  }
}
`

const BLOCK = 65536

export const SCAN_SCRIPT = [
  `tab=$(printf '\\t')`,
  `problems=$(mktemp) || exit 1`,
  `trap 'rm -f "$problems"' EXIT`,
  `job=0`,
  `while IFS="$tab" read -r off len path; do`,
  `  printf '## file %s %s\\n' "$job" "$off"`,
  `  skip=$((off / ${BLOCK}))`,
  `  base=$((skip * ${BLOCK}))`,
  `  end=$((off + len))`,
  `  if [ "$len" -le 0 ]; then`,
  `    printf '## done %s\\n' "$off"`,
  `    job=$((job + 1))`,
  `    continue`,
  `  fi`,
  `  last=$(dd if="$path" bs=1 skip="$((end - 1))" count=1 2>/dev/null | od -An -tx1 | tr -d ' \\n')`,
  `  if [ -z "$last" ]; then`,
  `    printf '## fail %s\\n' "this log could not be read"`,
  `  else`,
  `    dd if="$path" bs=${BLOCK} skip="$skip" 2>/dev/null | head -c "$((end - base))" | LC_ALL=C grep -abF '"usage":{' 2>"$problems" | LC_ALL=C awk -v base="$base" "$1" 2>>"$problems"`,
  `    if [ -s "$problems" ]; then`,
  `      printf '## fail %s\\n' "$(head -n 1 "$problems")"`,
  `      : > "$problems"`,
  `    elif [ "$last" = "0a" ]; then`,
  `      printf '## done %s\\n' "$end"`,
  `    else`,
  `      start=$(dd if="$path" bs=${BLOCK} skip="$skip" 2>/dev/null | head -c "$((end - base))" | LC_ALL=C grep -abo '^.' | tail -n 1 | cut -d: -f1)`,
  `      printf '## done %s\\n' "$((base + \${start:-0}))"`,
  `    fi`,
  `  fi`,
  `  job=$((job + 1))`,
  `done`,
].join('\n')

export const SCAN_ARGV: readonly string[] = ['/bin/sh', '-c', SCAN_SCRIPT, 'scan', EXTRACT]

export const jobLines = (jobs: readonly Job[]): string =>
  jobs.map(job => `${job.offset}\t${job.length}\t${job.path}\n`).join('')

const LONG_CONTEXT = /\[1m\]$/

const count = (text: string | undefined): number | null => (text && /^\d+$/.test(text) ? Number(text) : null)

const replyOf = (line: string, from: number, to: number): Reply | null => {
  const [start, model, id, requestId, timestamp, input, output, write, read, write5m, write1h] = line.split('\t')
  const startAt = count(start)
  const inputTokens = count(input)
  const outputTokens = count(output)
  const at = Date.parse(timestamp ?? '')
  if (startAt === null || startAt < from || startAt >= to || !model || !id || !requestId) return null
  if (inputTokens === null || outputTokens === null || Number.isNaN(at)) return null
  const fiveMinutes = count(write5m)
  const oneHour = count(write1h)
  const hasSplit = fiveMinutes !== null || oneHour !== null
  return {
    key: `${id}|${requestId}`,
    model: model.replace(LONG_CONTEXT, ''),
    at,
    tokens: [inputTokens, outputTokens, hasSplit ? (fiveMinutes ?? 0) : (count(write) ?? 0), hasSplit ? (oneHour ?? 0) : 0, count(read) ?? 0],
  }
}

export type ReaderEvents = { onFile: (result: FileResult) => void; onFail: (failure: FileFailure) => void }

export const createReader = ({ onFile, onFail }: ReaderEvents) => {
  let carry = ''
  let index: number | null = null
  let from = 0
  let lines: string[] = []

  const take = (line: string) => {
    if (line.startsWith('## file ')) {
      const [job, offset] = line.slice(8).split(' ')
      index = Number(job)
      from = Number(offset) || 0
      lines = []
      return
    }
    if (line.startsWith('## done ') || line.startsWith('## fail ')) {
      const isDone = line.startsWith('## done ')
      const end = Math.max(from, Number(line.slice(8)) || 0)
      if (index !== null && isDone) onFile({ index, replies: lines.flatMap(one => replyOf(one, from, end) ?? []), end })
      if (index !== null && !isDone) onFail({ index, message: line.slice(8) })
      index = null
      lines = []
      return
    }
    if (index !== null && line !== '') lines.push(line)
  }

  return {
    feed: (text: string) => {
      const split = (carry + text).split('\n')
      carry = split.pop() ?? ''
      split.forEach(take)
    },
    end: () => {
      if (carry !== '') take(carry)
      carry = ''
    },
  }
}

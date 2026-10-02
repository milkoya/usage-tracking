import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCAN_ARGV, createReader, jobLines } from '../hooks/scan.ts'
import type { FileFailure, FileResult, Job } from '../hooks/scan.ts'

const sample = new URL('./fixtures/sample.jsonl', import.meta.url).pathname
const bytes = readFileSync(sample)
const firstLine = bytes.indexOf(10) + 1
const secondLine = bytes.indexOf(10, firstLine) + 1
const thirdLine = bytes.indexOf(10, secondLine) + 1
const folder = mkdtempSync(join(tmpdir(), 'usage-scan-'))
const cut = join(folder, 'cut.jsonl')
writeFileSync(cut, bytes.subarray(0, thirdLine + 40))
const locked = join(folder, 'locked.jsonl')
writeFileSync(locked, bytes)
chmodSync(locked, 0)

const scanAll = (jobs: Job[]): { results: FileResult[]; failures: FileFailure[] } => {
  const [command, ...args] = SCAN_ARGV
  const output = execFileSync(command ?? '/bin/sh', args, { input: jobLines(jobs) }).toString()
  const results: FileResult[] = []
  const failures: FileFailure[] = []
  const reader = createReader({ onFile: result => results.push(result), onFail: failure => failures.push(failure) })
  for (let i = 0; i < output.length; i += 5) reader.feed(output.slice(i, i + 5))
  reader.end()
  return { results, failures }
}

const scan = (jobs: Job[]): FileResult[] => scanAll(jobs).results

const keys = (result: FileResult | undefined) => result?.replies.map(reply => `${reply.key} ${reply.tokens.join(',')}`)

const models = (result: FileResult | undefined) => result?.replies.map(reply => reply.model)

const [whole] = scan([{ path: sample, offset: 0, length: bytes.length }])
assert.deepEqual(keys(whole), ['msg_A|req_A 2,5,0,3,4', 'msg_B|req_B 7,11,0,0,9', 'msg_C|req_C 2,10,0,4868,159896', 'msg_D|req_D 1,3,0,0,6', 'msg_E|req_E 4,20,0,10,100', 'msg_E#advisor1|req_E 1000,300,0,0,0', 'msg_F|req_F 3,9,0,0,30', 'msg_F#advisor1|req_F 700,80,0,0,0', 'msg_F#advisor2|req_F 900,90,0,0,0'])
assert.equal(whole?.end, bytes.length)
assert.deepEqual(models(whole)?.slice(-5), ['claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-fable-5-1'])

const [partial] = scan([{ path: cut, offset: 0, length: thirdLine + 40 }])
assert.deepEqual(keys(partial), ['msg_A|req_A 2,5,0,3,4'])
assert.equal(partial?.end, thirdLine)

const [later] = scan([{ path: sample, offset: secondLine, length: bytes.length - secondLine }])
assert.deepEqual(keys(later), ['msg_B|req_B 7,11,0,0,9', 'msg_C|req_C 2,10,0,4868,159896', 'msg_D|req_D 1,3,0,0,6', 'msg_E|req_E 4,20,0,10,100', 'msg_E#advisor1|req_E 1000,300,0,0,0', 'msg_F|req_F 3,9,0,0,30', 'msg_F#advisor1|req_F 700,80,0,0,0', 'msg_F#advisor2|req_F 900,90,0,0,0'])

const trouble = scanAll([
  { path: locked, offset: 0, length: bytes.length },
  { path: cut, offset: 0, length: bytes.length },
  { path: sample, offset: 0, length: firstLine },
])
assert.deepEqual(trouble.failures.map(failure => failure.index), [0, 1])
assert.deepEqual(trouble.results.map(result => [result.index, result.end, result.replies.length]), [[2, firstLine, 0]])

console.log('scan check passed')

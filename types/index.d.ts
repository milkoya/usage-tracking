export type Tokens = [input: number, output: number, write5m: number, write1h: number, read: number]

export type Cursor = { size: number; offset: number; mtimeMs: number; recent: Record<string, Tokens> }

export type Ledger = { buckets: Record<string, Tokens>; cursors: Record<string, Cursor> }

export type ScanStatus = { isScanning: boolean; done: number; total: number; updatedAt: number | null; error: string | null }

declare module 'claude-code' {
  interface PluginState {
    'usage-tracking': {
      status: ScanStatus
      revision: number
      week: number
      anchor: number | null
      inTerminal: boolean
    }
  }
}

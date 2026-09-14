import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { CompactionTrace, RetrievalTrace } from '@dsh-memory/core'

export type TelemetryEvent =
  | {
    readonly type: 'plugin/started'
    readonly time: number
    readonly databasePath: string
    readonly apiBaseline: string
  }
  | {
    readonly type: 'memory/ingested'
    readonly time: number
    readonly sessionId: string
    readonly sourceEventSeq: number
    readonly inserted: boolean
  }
  | {
    readonly type: 'memory/retrieval'
    readonly time: number
    readonly trace: RetrievalTrace
  }
  | {
    readonly type: 'memory/compaction'
    readonly time: number
    readonly trace: CompactionTrace
  }
  | {
    readonly type: 'plugin/error'
    readonly time: number
    readonly operation: string
    readonly message: string
  }

export interface TelemetrySink {
  record(event: TelemetryEvent): void
}

export class JsonlTelemetrySink implements TelemetrySink {
  readonly filename: string

  constructor(filename: string) {
    this.filename = resolve(filename)
    mkdirSync(dirname(this.filename), { recursive: true })
  }

  record(event: TelemetryEvent): void {
    appendFileSync(this.filename, `${JSON.stringify(event)}\n`, 'utf8')
  }
}

export class NoopTelemetrySink implements TelemetrySink {
  record(): void {}
}

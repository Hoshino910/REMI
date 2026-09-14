import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  MemoryRecord,
  MemoryRole,
  MemoryStore,
  RetrievalTrace,
  StoreStats,
} from '@dsh-memory/core'

export interface SqliteMemoryStoreConfig {
  readonly filename: string
}

interface MemoryRow {
  id: string
  session_id: string
  source_event_seq: number | null
  role: string
  source_type: string
  content: string
  content_hash: string
  embedding: Uint8Array
  importance: number
  created_at: number
  last_accessed_at: number
  access_count: number
  estimated_tokens: number
  metadata_json: string
}

function encodeEmbedding(values: readonly number[]): Uint8Array {
  const floats = Float32Array.from(values)
  return new Uint8Array(floats.buffer.slice(0))
}

function decodeEmbedding(value: Uint8Array): number[] {
  const bytes = Uint8Array.from(value)
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4))
  return Array.from(floats)
}

function rowToRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    ...(row.source_event_seq === null ? {} : { sourceEventSeq: row.source_event_seq }),
    role: row.role as MemoryRole,
    sourceType: row.source_type,
    content: row.content,
    contentHash: row.content_hash,
    embedding: decodeEmbedding(row.embedding),
    importance: row.importance,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    accessCount: row.access_count,
    estimatedTokens: row.estimated_tokens,
    metadata: JSON.parse(row.metadata_json) as MemoryRecord['metadata'],
  }
}

export class SqliteMemoryStore implements MemoryStore {
  readonly filename: string
  private readonly database: DatabaseSync
  private closed = false

  constructor(config: SqliteMemoryStoreConfig) {
    if (config.filename.length === 0) throw new Error('SQLite filename cannot be empty')
    this.filename = config.filename === ':memory:' ? config.filename : resolve(config.filename)
    if (this.filename !== ':memory:') mkdirSync(dirname(this.filename), { recursive: true })
    this.database = new DatabaseSync(this.filename)
    this.database.exec('PRAGMA foreign_keys = ON')
    this.database.exec('PRAGMA busy_timeout = 5000')
    if (this.filename !== ':memory:') this.database.exec('PRAGMA journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      INSERT INTO schema_meta(key, value) VALUES ('schema_version', '1')
      ON CONFLICT(key) DO NOTHING;

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        source_event_seq INTEGER,
        role TEXT NOT NULL,
        source_type TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        embedding BLOB NOT NULL,
        importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
        created_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        estimated_tokens INTEGER NOT NULL,
        metadata_json TEXT NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS memories_session_event
        ON memories(session_id, source_event_seq)
        WHERE source_event_seq IS NOT NULL;
      CREATE INDEX IF NOT EXISTS memories_session_created
        ON memories(session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS retrieval_traces (
        trace_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS retrieval_traces_session_started
        ON retrieval_traces(session_id, started_at DESC);
    `)
  }

  async put(record: MemoryRecord): Promise<boolean> {
    this.assertOpen()
    const result = this.database.prepare(`
      INSERT INTO memories (
        id, session_id, source_event_seq, role, source_type, content, content_hash,
        embedding, importance, created_at, last_accessed_at, access_count,
        estimated_tokens, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(
      record.id,
      record.sessionId,
      record.sourceEventSeq ?? null,
      record.role,
      record.sourceType,
      record.content,
      record.contentHash,
      encodeEmbedding(record.embedding),
      record.importance,
      record.createdAt,
      record.lastAccessedAt,
      record.accessCount,
      record.estimatedTokens,
      JSON.stringify(record.metadata),
    )
    return result.changes > 0
  }

  async listBySession(sessionId: string, limit: number): Promise<readonly MemoryRecord[]> {
    this.assertOpen()
    const rows = this.database.prepare(`
      SELECT id, session_id, source_event_seq, role, source_type, content,
        content_hash, embedding, importance, created_at, last_accessed_at,
        access_count, estimated_tokens, metadata_json
      FROM memories
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(sessionId, Math.max(0, Math.floor(limit))) as unknown as MemoryRow[]
    return rows.map(rowToRecord)
  }

  async touch(ids: readonly string[], at: number): Promise<void> {
    this.assertOpen()
    if (ids.length === 0) return
    const statement = this.database.prepare(`
      UPDATE memories
      SET last_accessed_at = ?, access_count = access_count + 1
      WHERE id = ?
    `)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      for (const id of ids) statement.run(at, id)
      this.database.exec('COMMIT')
    } catch (error: unknown) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  async appendTrace(trace: RetrievalTrace): Promise<void> {
    this.assertOpen()
    this.database.prepare(`
      INSERT INTO retrieval_traces(trace_id, session_id, started_at, payload_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(trace_id) DO NOTHING
    `).run(trace.traceId, trace.sessionId, trace.startedAt, JSON.stringify(trace))
  }

  async listTraces(sessionId: string, limit = 100): Promise<readonly RetrievalTrace[]> {
    this.assertOpen()
    const rows = this.database.prepare(`
      SELECT payload_json FROM retrieval_traces
      WHERE session_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(sessionId, Math.max(0, Math.floor(limit))) as unknown as Array<{ payload_json: string }>
    return rows.map(row => JSON.parse(row.payload_json) as RetrievalTrace)
  }

  async stats(): Promise<StoreStats> {
    this.assertOpen()
    const memories = this.database.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }
    const traces = this.database.prepare('SELECT COUNT(*) AS count FROM retrieval_traces').get() as { count: number }
    return { memories: Number(memories.count), traces: Number(traces.count) }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SQLite memory store is closed')
  }
}

export type { SQLInputValue }

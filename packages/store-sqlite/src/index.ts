import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  AssociationEdge,
  AssociationReinforcement,
  MemoryRecord,
  MemoryRole,
  MemoryStore,
  RetrievalTrace,
  StoreStats,
} from '@dsh-memory/core'

export interface SqliteMemoryStoreConfig {
  readonly filename: string
  /** Optional provenance quarantine; filtering happens before candidate LIMIT. */
  readonly excludedSourceKinds?: readonly string[]
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
  emotion_json: string | null
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

const DAY_MS = 86_400_000

function canonicalPair(left: string, right: string): readonly [string, string] {
  return left < right ? [left, right] : [right, left]
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
    ...(row.emotion_json === null
      ? {}
      : { emotion: JSON.parse(row.emotion_json) as NonNullable<MemoryRecord['emotion']> }),
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
  private readonly excludedSourceKinds: readonly string[]

  constructor(config: SqliteMemoryStoreConfig) {
    this.excludedSourceKinds = [...new Set(config.excludedSourceKinds ?? [])]
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

      INSERT INTO schema_meta(key, value) VALUES ('schema_version', '2')
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
        emotion_json TEXT,
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

      CREATE TABLE IF NOT EXISTS memory_associations (
        session_id TEXT NOT NULL,
        source_memory_id TEXT NOT NULL,
        target_memory_id TEXT NOT NULL,
        weight REAL NOT NULL CHECK (weight >= 0),
        coactivation_count INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, source_memory_id, target_memory_id),
        CHECK (source_memory_id < target_memory_id),
        FOREIGN KEY (source_memory_id) REFERENCES memories(id) ON DELETE CASCADE,
        FOREIGN KEY (target_memory_id) REFERENCES memories(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS memory_associations_source
        ON memory_associations(session_id, source_memory_id, weight DESC);
      CREATE INDEX IF NOT EXISTS memory_associations_target
        ON memory_associations(session_id, target_memory_id, weight DESC);
    `)
    const columns = this.database.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>
    if (!columns.some(column => column.name === 'emotion_json')) {
      this.database.exec('ALTER TABLE memories ADD COLUMN emotion_json TEXT')
    }
    this.database.prepare(`
      INSERT INTO schema_meta(key, value) VALUES ('schema_version', '2')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run()
  }

  async put(record: MemoryRecord): Promise<boolean> {
    this.assertOpen()
    const result = this.database.prepare(`
      INSERT INTO memories (
        id, session_id, source_event_seq, role, source_type, content, content_hash,
        embedding, importance, emotion_json, created_at, last_accessed_at, access_count,
        estimated_tokens, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      record.emotion === undefined ? null : JSON.stringify(record.emotion),
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
    const quarantine = this.excludedSourceKinds.length === 0 ? ''
      : `AND COALESCE(json_extract(metadata_json, '$.sourceKind'), '') NOT IN (${this.excludedSourceKinds.map(() => '?').join(',')})`
    const rows = this.database.prepare(`
      SELECT id, session_id, source_event_seq, role, source_type, content,
        content_hash, embedding, importance, emotion_json, created_at, last_accessed_at,
        access_count, estimated_tokens, metadata_json
      FROM memories
      WHERE session_id = ?
        ${quarantine}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(sessionId, ...this.excludedSourceKinds, Math.max(0, Math.floor(limit))) as unknown as MemoryRow[]
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

  async listAssociations(
    sessionId: string,
    memoryIds: readonly string[],
    limit: number,
  ): Promise<readonly AssociationEdge[]> {
    this.assertOpen()
    const ids = [...new Set(memoryIds)]
    if (ids.length === 0 || limit <= 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.database.prepare(`
      SELECT session_id, source_memory_id, target_memory_id, weight,
        coactivation_count, created_at, updated_at
      FROM memory_associations
      WHERE session_id = ?
        AND (source_memory_id IN (${placeholders}) OR target_memory_id IN (${placeholders}))
      ORDER BY weight DESC, updated_at DESC
      LIMIT ?
    `).all(sessionId, ...ids, ...ids, Math.floor(limit)) as unknown as Array<{
      session_id: string
      source_memory_id: string
      target_memory_id: string
      weight: number
      coactivation_count: number
      created_at: number
      updated_at: number
    }>
    return rows.map(row => ({
      sessionId: row.session_id,
      sourceMemoryId: row.source_memory_id,
      targetMemoryId: row.target_memory_id,
      weight: row.weight,
      coActivationCount: row.coactivation_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  async reinforceAssociations(input: AssociationReinforcement): Promise<number> {
    this.assertOpen()
    const ids = [...new Set(input.memoryIds)].sort()
    if (ids.length < 2) return 0
    const select = this.database.prepare(`
      SELECT weight, coactivation_count, created_at, updated_at
      FROM memory_associations
      WHERE session_id = ? AND source_memory_id = ? AND target_memory_id = ?
    `)
    const upsert = this.database.prepare(`
      INSERT INTO memory_associations (
        session_id, source_memory_id, target_memory_id, weight,
        coactivation_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, source_memory_id, target_memory_id) DO UPDATE SET
        weight = excluded.weight,
        coactivation_count = excluded.coactivation_count,
        updated_at = excluded.updated_at
    `)
    let updated = 0
    this.database.exec('BEGIN IMMEDIATE')
    try {
      for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex += 1) {
          const left = ids[leftIndex]
          const right = ids[rightIndex]
          if (left === undefined || right === undefined || left === right) continue
          const [source, target] = canonicalPair(left, right)
          const existing = select.get(input.sessionId, source, target) as {
            weight: number
            coactivation_count: number
            created_at: number
            updated_at: number
          } | undefined
          const ageDays = existing === undefined ? 0 : Math.max(0, input.at - existing.updated_at) / DAY_MS
          const decayed = existing === undefined
            ? 0
            : existing.weight * Math.pow(0.5, ageDays / Math.max(0.01, input.halfLifeDays))
          const activation = Math.sqrt(
            Math.max(0, input.activations[left] ?? 0)
            * Math.max(0, input.activations[right] ?? 0),
          )
          const weight = Math.min(input.maxWeight, decayed + input.learningRate * activation)
          upsert.run(
            input.sessionId,
            source,
            target,
            weight,
            (existing?.coactivation_count ?? 0) + 1,
            existing?.created_at ?? input.at,
            input.at,
          )
          updated += 1
        }
      }
      this.database.exec('COMMIT')
      return updated
    } catch (error: unknown) {
      this.database.exec('ROLLBACK')
      throw error
    }
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
    const associations = this.database.prepare('SELECT COUNT(*) AS count FROM memory_associations').get() as { count: number }
    return { memories: Number(memories.count), traces: Number(traces.count), associations: Number(associations.count) }
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

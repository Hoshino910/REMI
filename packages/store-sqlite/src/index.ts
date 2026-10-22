import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  AssociationEdge,
  AssociationReinforcement,
  AssociationReinforcementResult,
  MemoryRecord,
  MemoryLifecycleStatus,
  MemoryListOptions,
  MemoryRevisionSource,
  MemorySupersession,
  MemoryRole,
  MemoryStore,
  RetrievalTrace,
  StoreStats,
  MemoryScope,
  ForgetRequest,
  ForgetResult,
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
  status: string
  supersedes_memory_id: string | null
  superseded_by_memory_id: string | null
  valid_from: number
  valid_until: number | null
  revision_reason: string | null
  revision_source: string | null
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
    status: row.status as MemoryLifecycleStatus,
    ...(row.supersedes_memory_id === null ? {} : { supersedesMemoryId: row.supersedes_memory_id }),
    ...(row.superseded_by_memory_id === null ? {} : { supersededByMemoryId: row.superseded_by_memory_id }),
    validFrom: row.valid_from,
    ...(row.valid_until === null ? {} : { validUntil: row.valid_until }),
    ...(row.revision_reason === null ? {} : { revisionReason: row.revision_reason }),
    ...(row.revision_source === null ? {} : { revisionSource: row.revision_source as MemoryRevisionSource }),
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

      INSERT INTO schema_meta(key, value) VALUES ('schema_version', '3')
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
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'excluded', 'deleted')),
        supersedes_memory_id TEXT,
        superseded_by_memory_id TEXT,
        valid_from INTEGER NOT NULL DEFAULT 0,
        valid_until INTEGER,
        revision_reason TEXT,
        revision_source TEXT,
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
      CREATE TABLE IF NOT EXISTS session_scopes (
        session_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL CHECK(length(owner_id) > 0),
        project_id TEXT NOT NULL CHECK(length(project_id) > 0)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS session_scopes_project ON session_scopes(owner_id, project_id);
      CREATE TABLE IF NOT EXISTS content_tombstones (
        session_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, content_hash)
      ) STRICT;
    `)
    const columns = this.database.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>
    if (!columns.some(column => column.name === 'emotion_json')) {
      this.database.exec('ALTER TABLE memories ADD COLUMN emotion_json TEXT')
    }
    const lifecycleColumns: ReadonlyArray<readonly [string, string]> = [
      ['status', "TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'excluded', 'deleted'))"],
      ['supersedes_memory_id', 'TEXT'],
      ['superseded_by_memory_id', 'TEXT'],
      ['valid_from', 'INTEGER NOT NULL DEFAULT 0'],
      ['valid_until', 'INTEGER'],
      ['revision_reason', 'TEXT'],
      ['revision_source', 'TEXT'],
    ]
    for (const [name, declaration] of lifecycleColumns) {
      if (!columns.some(column => column.name === name)) this.database.exec(`ALTER TABLE memories ADD COLUMN ${name} ${declaration}`)
    }
    this.database.exec(`
      UPDATE memories SET valid_from = created_at WHERE valid_from = 0;
      CREATE INDEX IF NOT EXISTS memories_session_status_created
        ON memories(session_id, status, created_at DESC);
    `)
    this.database.prepare(`
      INSERT INTO schema_meta(key, value) VALUES ('schema_version', '4')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run()
    // Distinct namespaces prevent arbitrary session names colliding with project graphs.
    if (!this.database.prepare("SELECT 1 FROM schema_meta WHERE key = 'graph_namespace_v1'").get()) {
      this.database.exec('BEGIN IMMEDIATE')
      try {
        this.database.exec("UPDATE memory_associations SET session_id = 'session:' || json_quote(session_id)")
        this.database.exec("INSERT INTO schema_meta(key, value) VALUES ('graph_namespace_v1', '1')")
        this.database.exec('COMMIT')
      } catch (error: unknown) { this.database.exec('ROLLBACK'); throw error }
    }
  }

  private insertRecord(record: MemoryRecord): boolean {
    const result = this.database.prepare(`
      INSERT INTO memories (
        id, session_id, source_event_seq, role, source_type, content, content_hash,
        embedding, importance, emotion_json, status, supersedes_memory_id,
        superseded_by_memory_id, valid_from, valid_until, revision_reason, revision_source,
        created_at, last_accessed_at, access_count, estimated_tokens, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      record.status,
      record.supersedesMemoryId ?? null,
      record.supersededByMemoryId ?? null,
      record.validFrom,
      record.validUntil ?? null,
      record.revisionReason ?? null,
      record.revisionSource ?? null,
      record.createdAt,
      record.lastAccessedAt,
      record.accessCount,
      record.estimatedTokens,
      JSON.stringify(record.metadata),
    )
    return result.changes > 0
  }

  async put(record: MemoryRecord): Promise<boolean> {
    this.assertOpen()
    if (await this.isContentBlocked(record.sessionId, record.contentHash)) return false
    return this.insertRecord(record)
  }

  async isContentBlocked(sessionId: string, contentHash: string): Promise<boolean> {
    this.assertOpen()
    const sessions = `SELECT session_id FROM session_scopes WHERE (owner_id, project_id) IN
      (SELECT owner_id, project_id FROM session_scopes WHERE session_id = ?)`
    return this.database.prepare(`
      SELECT 1 FROM content_tombstones WHERE content_hash = ? AND (session_id = ? OR session_id IN (${sessions}))
      UNION ALL
      SELECT 1 FROM memories WHERE content_hash = ? AND status != 'active'
        AND (session_id = ? OR session_id IN (${sessions})) LIMIT 1
    `).get(contentHash, sessionId, sessionId, contentHash, sessionId, sessionId) !== undefined
  }

  async supersede(input: MemorySupersession): Promise<boolean> {
    this.assertOpen()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const target = this.database.prepare(`
        SELECT session_id, status, superseded_by_memory_id
        FROM memories WHERE id = ?
      `).get(input.targetMemoryId) as {
        session_id: string
        status: MemoryLifecycleStatus
        superseded_by_memory_id: string | null
      } | undefined
      if (target === undefined || (target.session_id !== input.sessionId && !this.sameScope(target.session_id, input.sessionId))) {
        throw new Error('Supersession target does not exist in the requested session')
      }
      if (target.status === 'superseded' && target.superseded_by_memory_id === input.replacement.id) {
        this.database.exec('COMMIT')
        return false
      }
      if (target.status !== 'active') throw new Error(`Cannot supersede a ${target.status} memory`)
      if (input.replacement.sessionId !== input.sessionId
        || input.replacement.status !== 'active'
        || input.replacement.supersedesMemoryId !== input.targetMemoryId) {
        throw new Error('Replacement lifecycle linkage is invalid')
      }
      const inserted = this.insertRecord(input.replacement)
      if (!inserted) throw new Error('Replacement memory conflicts with an existing record')
      const result = this.database.prepare(`
        UPDATE memories
        SET status = 'superseded', superseded_by_memory_id = ?, valid_until = ?,
          revision_reason = ?, revision_source = ?
        WHERE id = ? AND session_id = ? AND status = 'active'
      `).run(
        input.replacement.id, input.at, input.reason, input.source,
        input.targetMemoryId, target.session_id,
      )
      if (result.changes !== 1) throw new Error('Supersession target changed concurrently')
      this.database.exec('COMMIT')
      return true
    } catch (error: unknown) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  async bindSessionScope(sessionId: string, scope: MemoryScope): Promise<void> {
    this.assertOpen()
    if (![sessionId, scope.ownerId, scope.projectId].every(value => value.trim().length > 0)) {
      throw new Error('Session, owner and project identifiers must be non-empty')
    }
    this.database.prepare(`
      INSERT INTO session_scopes(session_id, owner_id, project_id) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO NOTHING
    `).run(sessionId, scope.ownerId, scope.projectId)
    const row = this.database.prepare('SELECT owner_id, project_id FROM session_scopes WHERE session_id = ?')
      .get(sessionId) as { owner_id: string; project_id: string }
    if (row.owner_id !== scope.ownerId || row.project_id !== scope.projectId) {
      throw new Error('Session scope is immutable; use a new session for another owner or project')
    }
  }

  private sameScope(left: string, right: string): boolean {
    return this.database.prepare(`
      SELECT 1 FROM session_scopes a JOIN session_scopes b
        ON a.owner_id = b.owner_id AND a.project_id = b.project_id
      WHERE a.session_id = ? AND b.session_id = ?
    `).get(left, right) !== undefined
  }

  private graphKey(sessionId: string, scope: 'session' | 'project' = 'session'): string {
    if (scope === 'session') return `session:${JSON.stringify(sessionId)}`
    const binding = this.database.prepare('SELECT owner_id, project_id FROM session_scopes WHERE session_id = ?')
      .get(sessionId) as { owner_id: string; project_id: string } | undefined
    if (!binding) throw new Error('Project graph requires a bound session scope')
    return `project:${JSON.stringify([binding.owner_id, binding.project_id])}`
  }

  async listByScope(sessionId: string, limit: number, options: MemoryListOptions = {}): Promise<readonly MemoryRecord[]> {
    this.assertOpen()
    const binding = this.database.prepare('SELECT owner_id, project_id FROM session_scopes WHERE session_id = ?')
      .get(sessionId) as { owner_id: string; project_id: string } | undefined
    if (binding === undefined) throw new Error('Project retrieval requires a bound session scope')
    const quarantine = this.excludedSourceKinds.length === 0 ? ''
      : `AND COALESCE(json_extract(m.metadata_json, '$.sourceKind'), '') NOT IN (${this.excludedSourceKinds.map(() => '?').join(',')})`
    const rows = this.database.prepare(`
      SELECT m.* FROM memories m JOIN session_scopes s ON s.session_id = m.session_id
      WHERE s.owner_id = ? AND s.project_id = ?
        ${options.includeInactive === true ? '' : "AND m.status = 'active'"}
        ${quarantine}
      ORDER BY CASE m.status WHEN 'active' THEN 0 ELSE 1 END, m.created_at DESC, m.id
      LIMIT ?
    `).all(binding.owner_id, binding.project_id, ...this.excludedSourceKinds, Math.max(0, Math.floor(limit))) as unknown as MemoryRow[]
    return rows.map(rowToRecord)
  }

  /** Logical deletion/scrubbing; this cannot erase host logs, backups or SQLite free pages. */
  async forget(input: ForgetRequest): Promise<ForgetResult> {
    this.assertOpen()
    if (!['exclude', 'delete', 'purge'].includes(input.mode)) throw new Error('Invalid forget mode')
    const at = input.at ?? Date.now()
    if (!Number.isFinite(at)) throw new Error('Invalid forget timestamp')
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const accessible = this.database.prepare(`
        SELECT id, session_id, supersedes_memory_id, superseded_by_memory_id FROM memories
        WHERE session_id = ? OR session_id IN (
          SELECT a.session_id FROM session_scopes a JOIN session_scopes b
            ON a.owner_id = b.owner_id AND a.project_id = b.project_id WHERE b.session_id = ?
        )
      `).all(input.sessionId, input.sessionId) as Array<{ id: string; session_id: string; supersedes_memory_id: string | null; superseded_by_memory_id: string | null }>
      const byId = new Map(accessible.map(row => [row.id, row]))
      const selected = new Set(input.memoryIds)
      for (const id of selected) if (!byId.has(id)) throw new Error('Forget target does not exist in the requested session')
      if (input.includeRevisions !== false) {
        // Traverse in both directions, including migrated one-sided links.
        let expanded = true
        while (expanded) {
          expanded = false
          for (const row of accessible) {
            if (selected.has(row.id) || selected.has(row.supersedes_memory_id ?? '') || selected.has(row.superseded_by_memory_id ?? '')) {
              for (const id of [row.id, row.supersedes_memory_id, row.superseded_by_memory_id]) {
                if (id !== null && byId.has(id) && !selected.has(id)) { selected.add(id); expanded = true }
              }
            }
          }
        }
      }
      let removedEdges = 0
      for (const id of selected) {
        this.database.prepare(`
          INSERT OR IGNORE INTO content_tombstones(session_id, content_hash, created_at)
          SELECT session_id, content_hash, ? FROM memories WHERE id = ? AND content_hash NOT LIKE 'purged:%'
        `).run(at, id)
        removedEdges += Number(this.database.prepare(`
          DELETE FROM memory_associations WHERE source_memory_id = ? OR target_memory_id = ?
        `).run(id, id).changes)
        this.database.prepare(`
          UPDATE memories SET status = CASE WHEN status = 'deleted' THEN 'deleted' ELSE ? END,
            valid_until = COALESCE(valid_until, ?), revision_reason = 'Explicit local forget', revision_source = 'manual'
          WHERE id = ? AND session_id = ?
        `).run(input.mode === 'exclude' ? 'excluded' : 'deleted', at, id, byId.get(id)!.session_id)
        if (input.mode === 'purge') {
          this.database.prepare(`
            UPDATE memories SET content = '', content_hash = ?, embedding = X'', emotion_json = NULL,
              metadata_json = '{}', importance = 0, estimated_tokens = 0 WHERE id = ?
          `).run(`purged:${id}`, id)
        }
      }
      this.database.exec('COMMIT')
      return { affectedIds: [...selected].sort(), removedEdges, mode: input.mode }
    } catch (error: unknown) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  async listBySession(sessionId: string, limit: number, options: MemoryListOptions = {}): Promise<readonly MemoryRecord[]> {
    this.assertOpen()
    const quarantine = this.excludedSourceKinds.length === 0 ? ''
      : `AND COALESCE(json_extract(metadata_json, '$.sourceKind'), '') NOT IN (${this.excludedSourceKinds.map(() => '?').join(',')})`
    const lifecycle = options.includeInactive === true ? '' : "AND status = 'active'"
    const rows = this.database.prepare(`
      SELECT id, session_id, source_event_seq, role, source_type, content,
        content_hash, embedding, importance, emotion_json, status, supersedes_memory_id,
        superseded_by_memory_id, valid_from, valid_until, revision_reason, revision_source,
        created_at, last_accessed_at, access_count, estimated_tokens, metadata_json
      FROM memories
      WHERE session_id = ?
        ${quarantine}
        ${lifecycle}
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC
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
    scope: 'session' | 'project' = 'session',
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
    `).all(this.graphKey(sessionId, scope), ...ids, ...ids, Math.floor(limit)) as unknown as Array<{
      session_id: string
      source_memory_id: string
      target_memory_id: string
      weight: number
      coactivation_count: number
      created_at: number
      updated_at: number
    }>
    return rows.map(row => ({
      sessionId,
      sourceMemoryId: row.source_memory_id,
      targetMemoryId: row.target_memory_id,
      weight: row.weight,
      coActivationCount: row.coactivation_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  async reinforceAssociations(input: AssociationReinforcement): Promise<AssociationReinforcementResult> {
    this.assertOpen()
    const ids = [...new Set(input.memoryIds)].sort()
    const graphKey = this.graphKey(input.sessionId, input.scope)
    const countForSession = this.database.prepare(`
      SELECT COUNT(*) AS count FROM memory_associations WHERE session_id = ?
    `)
    if (ids.length < 2) {
      const current = countForSession.get(graphKey) as { count: number }
      return { reinforcedEdges: 0, prunedEdges: 0, storedEdges: Number(current.count) }
    }
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
    const prune = this.database.prepare(`
      DELETE FROM memory_associations
      WHERE rowid IN (
        SELECT rowid FROM memory_associations
        WHERE session_id = ?
        ORDER BY weight ASC, updated_at ASC, coactivation_count ASC,
          source_memory_id DESC, target_memory_id DESC
        LIMIT ?
      )
    `)
    let updated = 0
    this.database.exec('BEGIN IMMEDIATE')
    try {
      for (const id of ids) {
        const row = this.database.prepare('SELECT session_id, status FROM memories WHERE id = ?').get(id) as { session_id: string; status: string } | undefined
        if (!row || row.status !== 'active' || (row.session_id !== input.sessionId
          && !(input.scope === 'project' && this.sameScope(row.session_id, input.sessionId)))) {
          throw new Error('Graph reinforcement requires active memories in the requested scope')
        }
      }
      for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex += 1) {
          const left = ids[leftIndex]
          const right = ids[rightIndex]
          if (left === undefined || right === undefined || left === right) continue
          const [source, target] = canonicalPair(left, right)
          const existing = select.get(graphKey, source, target) as {
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
            graphKey,
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
      const beforePrune = countForSession.get(graphKey) as { count: number }
      const excess = Math.max(0, Number(beforePrune.count) - Math.max(1, Math.floor(input.maxEdgesPerSession)))
      const pruned = excess === 0 ? 0 : Number(prune.run(graphKey, excess).changes)
      const afterPrune = countForSession.get(graphKey) as { count: number }
      this.database.exec('COMMIT')
      return {
        reinforcedEdges: updated,
        prunedEdges: pruned,
        storedEdges: Number(afterPrune.count),
      }
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

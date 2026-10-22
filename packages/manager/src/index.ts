import {
  SelectiveMemoryRuntime, retrievalView, stableHash,
  type ForgetRequest, type MemoryInput, type MemoryScope, type RetrievalRequest,
} from '@dsh-memory/core'
import { SqliteMemoryStore } from '@dsh-memory/store-sqlite'

export type ManagerRequest =
  | { operation: 'status' }
  | { operation: 'bind'; sessionId: string; scope: MemoryScope }
  | { operation: 'list' | 'export' | 'consolidation-preview'; sessionId: string; limit?: number; includeInactive?: boolean }
  | { operation: 'recall'; request: RetrievalRequest }
  | { operation: 'write'; memory: MemoryInput }
  | { operation: 'revise'; sessionId: string; targetMemoryId: string; content: string; timestamp: number }
  | { operation: 'forget'; request: ForgetRequest }

/** Shared local management service. A DSH UI can call this without inventing another store. */
export class MemoryManager {
  constructor(readonly store: SqliteMemoryStore) {}

  async execute(input: ManagerRequest, allowWrite = false): Promise<unknown> {
    const mutating = ['bind', 'write', 'revise', 'forget'].includes(input.operation)
    if (mutating && !allowWrite) throw new Error('Mutation requires explicit write mode')
    const runtime = new SelectiveMemoryRuntime(this.store)
    switch (input.operation) {
      case 'status': return { schemaVersion: 4, ...await this.store.stats() }
      case 'bind':
        await this.store.bindSessionScope(input.sessionId, input.scope)
        return { bound: true, sessionId: input.sessionId }
      case 'write': {
        const inserted = await runtime.ingest(input.memory)
        return { inserted }
      }
      case 'revise': return { inserted: await runtime.supersede({
        sessionId: input.sessionId, targetMemoryId: input.targetMemoryId,
        replacement: { role: 'user', sourceType: 'manual/revision', content: input.content, timestamp: input.timestamp },
        at: input.timestamp, reason: 'Explicit ID-based manual revision', source: 'manual',
      }) }
      case 'forget': return this.store.forget(input.request)
      case 'recall':
        // A management preview is read-only: no touch, trace insertion or graph reinforcement.
        return new SelectiveMemoryRuntime({
          put: record => this.store.put(record),
          listBySession: (sessionId, limit, options) => this.store.listBySession(sessionId, limit, options),
          listByScope: (sessionId, limit, options) => this.store.listByScope(sessionId, limit, options),
          listAssociations: (sessionId, ids, limit, scope) => this.store.listAssociations(sessionId, ids, limit, scope),
          touch: async () => {}, appendTrace: async () => {},
          stats: () => this.store.stats(), close: async () => {},
        }).retrieve(input.request)
      case 'list': case 'export': case 'consolidation-preview': {
        const limit = Math.max(1, Math.min(10_000, input.limit ?? 1_000))
        const records = await this.store.listBySession(input.sessionId, limit, { includeInactive: input.includeInactive ?? false })
        if (input.operation === 'export') return { schemaVersion: 1, kind: 'remi-memory-export', records,
          limit, mayBeTruncated: records.length === limit }
        if (input.operation === 'list') return records.map(({ embedding: _embedding, ...record }) => record)
        const groups = new Map<string, string[]>()
        for (const record of records.filter(record => record.status === 'active')) {
          const key = stableHash(retrievalView(record.content).toLowerCase())
          groups.set(key, [...(groups.get(key) ?? []), record.id])
        }
        return {
          applied: false, scanned: records.length, mayBeTruncated: records.length === limit,
          proposals: [...groups.values()].filter(ids => ids.length > 1)
            .map(ids => ({ operation: 'review-duplicates', keepId: ids[0], candidateIds: ids.slice(1) })),
          note: 'Deterministic duplicate proposals only; no semantic rewriting or automatic deletion.',
        }
      }
    }
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object')
  return value as Record<string, unknown>
}
function text(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`)
}
function number(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be finite`)
}

/** JSON boundary for the CLI / future host UI; reject unknown operations and malformed inputs. */
export function parseManagerRequest(value: unknown): ManagerRequest {
  const input = object(value)
  const operation = input.operation
  if (!['status', 'bind', 'list', 'export', 'consolidation-preview', 'recall', 'write', 'revise', 'forget'].includes(String(operation))) {
    throw new Error('Unknown manager operation')
  }
  if (['bind', 'list', 'export', 'consolidation-preview', 'revise'].includes(String(operation))) text(input.sessionId, 'sessionId')
  if (input.limit !== undefined) { number(input.limit, 'limit'); if (input.limit < 1) throw new Error('limit must be positive') }
  if (input.includeInactive !== undefined && typeof input.includeInactive !== 'boolean') throw new Error('includeInactive must be boolean')
  if (operation === 'bind') { const scope = object(input.scope); text(scope.ownerId, 'ownerId'); text(scope.projectId, 'projectId') }
  if (operation === 'revise') { text(input.targetMemoryId, 'targetMemoryId'); text(input.content, 'content'); number(input.timestamp, 'timestamp') }
  if (operation === 'write') {
    const memory = object(input.memory)
    const allowed = ['sessionId', 'sourceEventSeq', 'role', 'sourceType', 'content', 'timestamp', 'importance', 'metadata', 'status']
    if (Object.keys(memory).some(key => !allowed.includes(key))) throw new Error('Unsupported manual memory field')
    text(memory.sessionId, 'sessionId'); text(memory.content, 'content'); text(memory.sourceType, 'sourceType'); number(memory.timestamp, 'timestamp')
    if (!['user', 'assistant', 'tool', 'unknown'].includes(String(memory.role))) throw new Error('Invalid role')
    if (memory.status !== undefined && memory.status !== 'active') throw new Error('Use forget/revise to change lifecycle')
    if (memory.sourceEventSeq !== undefined) { number(memory.sourceEventSeq, 'sourceEventSeq'); if (!Number.isSafeInteger(memory.sourceEventSeq)) throw new Error('Invalid sourceEventSeq') }
    if (memory.importance !== undefined) { number(memory.importance, 'importance'); if (memory.importance < 0 || memory.importance > 1) throw new Error('importance must be in [0,1]') }
    if (memory.metadata !== undefined) for (const item of Object.values(object(memory.metadata))) {
      if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) throw new Error('Metadata must contain scalar values')
      if (typeof item === 'number') number(item, 'metadata number')
    }
  }
  if (operation === 'recall') {
    const request = object(input.request)
    text(request.sessionId, 'sessionId'); text(request.query, 'query'); number(request.tokenBudget, 'tokenBudget')
    if (request.tokenBudget < 0) throw new Error('tokenBudget must be non-negative')
    if (request.scope !== undefined && !['session', 'project'].includes(String(request.scope))) throw new Error('Invalid recall scope')
    if (request.limit !== undefined) { number(request.limit, 'limit'); if (request.limit < 0) throw new Error('Invalid recall limit') }
    if (request.now !== undefined) number(request.now, 'now')
    if (request.includeSuperseded !== undefined && typeof request.includeSuperseded !== 'boolean') throw new Error('includeSuperseded must be boolean')
  }
  if (operation === 'forget') {
    const request = object(input.request)
    text(request.sessionId, 'sessionId')
    if (!['exclude', 'delete', 'purge'].includes(String(request.mode))) throw new Error('Invalid forget mode')
    if (!Array.isArray(request.memoryIds) || request.memoryIds.length === 0) throw new Error('memoryIds must be a non-empty array')
    for (const id of request.memoryIds) text(id, 'memoryId')
    if (request.includeRevisions !== undefined && typeof request.includeRevisions !== 'boolean') throw new Error('includeRevisions must be boolean')
    if (request.at !== undefined) number(request.at, 'at')
  }
  return input as unknown as ManagerRequest
}

#!/usr/bin/env node
// Fixture-driven full-run audit. No fixed event sequence IDs, provider calls,
// credentials, or writes to the live database.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { normalizeText, stableHash } from '../../core/dist/index.js'
import { scoreFields } from './score-recall-fields.mjs'

const [runArg, dbArg] = process.argv.slice(2)
if (!runArg || !dbArg) throw new Error('Usage: node audit-dsh-full-test.mjs RUN_DIR MEMORY_SQLITE')
const dir = resolve(runArg), fixture = resolve(dir, '..')
const read = name => JSON.parse(readFileSync(resolve(dir, name), 'utf8'))
const progress = read('progress.json')
const truth = JSON.parse(readFileSync(resolve(fixture, 'ground-truth.json'), 'utf8'))
const corpus = readFileSync(resolve(fixture, 'messages.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse)
const events = readFileSync(resolve(dir, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse)
const db = new DatabaseSync(dbArg, { readOnly: true })
const records = db.prepare('SELECT * FROM memories WHERE session_id=?').all(progress.sessionId)
const byId = new Map(records.map(m => [m.id, m]))
const traces = db.prepare('SELECT payload_json FROM retrieval_traces WHERE session_id=? ORDER BY started_at').all(progress.sessionId).map(r => JSON.parse(r.payload_json))
const associations = db.prepare('SELECT count(*) AS edges FROM memory_associations WHERE session_id=?').get(progress.sessionId).edges
const databaseSessions = db.prepare('SELECT DISTINCT session_id FROM memories UNION SELECT DISTINCT session_id FROM retrieval_traces UNION SELECT DISTINCT session_id FROM memory_associations').all().map(r=>r.session_id)
db.close()

const recall = progress.turns.filter(t => t.target).map(t => {
  const expected = truth.find(g => g.target === t.target).expected
  const query = corpus.find(m => m.index === t.index).text
  const fingerprint = stableHash(normalizeText(query))
  const matching = traces.filter(trace => trace.queryFingerprint === fingerprint)
  const trace = matching.length === 1 ? matching[0] : undefined
  const anchorText = corpus.find(m => m.stage === 'anchor' && normalizeText(m.text).includes(normalizeText(t.target))).text
  const anchor = records.find(m => m.content === normalizeText(anchorText))
  const candidate = trace?.candidates.find(c => c.memoryId === anchor?.id)
  const queryEvent = events.find(e=>e.type==='user/message' && e.data.source?.kind==='user' && normalizeText(e.data.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'))===normalizeText(query))
  const windowEvent = events.filter(e=>e.seq<t.endSeq && e.type==='user/message' && e.data.source.sections?.some(s=>s.name==='dsh-selective-memory:transparent-window')).at(-1)
  const windowText = windowEvent?.data.source.sections.find(s=>s.name==='dsh-selective-memory:transparent-window')?.text
  return { stage: t.stage, target: t.target, answer: t.answer, fields: scoreFields(t.answer, expected, t.target),
    traceMatchCount: matching.length, originalCandidateRank: candidate ? trace.candidates.findIndex(c => c.memoryId === candidate.memoryId) + 1 : null,
    originalSelected: candidate?.decision === 'selected', estimatedTokens: trace?.estimatedTokens,
    deliveredWindowSeq: windowEvent?.seq, windowUpdatedAfterQuery: Boolean(queryEvent && windowEvent && windowEvent.seq>queryEvent.seq),
    originalFactInDeliveredWindow: Boolean(anchor && windowText && normalizeText(windowText).includes(anchor.content)),
    selectedSourceSeqs: trace?.candidates.filter(c => c.decision === 'selected').map(c => byId.get(c.memoryId).source_event_seq) }
})
const sourceCounts = {}
for (const record of records) { const kind = JSON.parse(record.metadata_json).sourceKind; sourceCounts[kind] = (sourceCounts[kind] ?? 0) + 1 }
const selected = traces.flatMap(t => t.candidates.filter(c => c.decision === 'selected').map(c => byId.get(c.memoryId)))
const compactionEnd = events.filter(e => e.type === 'compaction/end').map(e => ({ seq: e.seq, error: e.data.error ?? null }))
const usage = events.filter(e => e.type === 'assistant/chunk' && e.data.chunk.type === 'usage').map(e => e.data.chunk.usage)
const total = key => usage.reduce((sum, item) => sum + (item[key] ?? 0), 0)
const scoreStage = stage => recall.filter(r => r.stage === stage).flatMap(r => r.fields).filter(f => f.correct).length
const report = { fixture: progress.fixture, sessionId: progress.sessionId, status: progress.status, startedAt: progress.startedAt, finishedAt: progress.finishedAt,
  cleanRoom: progress.cleanRoom ? {...progress.cleanRoom,databaseSessions,foreignSessionCount:databaseSessions.filter(id=>id!==progress.sessionId).length,firstRetrievalCandidateCount:traces[0]?.candidateCount} : undefined,
  completedPrompts: progress.completedPrompts, interferenceRounds: progress.turns.filter(t => t.stage === 'interference').length,
  submittedChars: progress.turns.reduce((sum, t) => sum + t.chars, 0), scoringVersions: [...new Set(traces.map(t => t.scoringVersion))],
  preCompactionCorrectFields: scoreStage('recall-before-compaction'), postCompactionCorrectFields: scoreStage('recall-after-compaction'), fieldsPerStage: 8,
  unknownAnswer: progress.turns.find(t => t.stage === 'unknown-control')?.answer,
  compactionEnd, surfaceGate: progress.surfaceGate, recall,
  memoryRecords: records.length, memorySources: sourceCounts, associationEdges: associations, retrievalTraces: traces.length,
  maxWindowEstimatedTokens: Math.max(0, ...traces.map(t => t.estimatedTokens)),
  selectedRuntimeSnapshots: selected.filter(m => /<memory-context\b/u.test(m.content)).length,
  runtimeWindowsDelivered: events.filter(e => e.type === 'user/message' && e.data.source.sections?.some(s => s.name === 'dsh-selective-memory:transparent-window')).length,
  retryEvents: events.filter(e => /retry/iu.test(e.type)).length, toolCalls: events.filter(e => e.type === 'tool/call').length,
  providerUsage: { samples: usage.length, inputTokens: total('inputTokens'), cacheReadTokens: total('cacheReadTokens'), outputTokens: total('outputTokens'), totalTokens: total('totalTokens') },
  limitations: ['Synthetic Chinese fixture; one successful run is not statistical evidence of generalization.', 'No no-plugin baseline, graph ablation, or emotion-model validation.', 'Pre-compaction accuracy cannot isolate the plugin contribution.', 'Field scoring requires a JSON object and recognized bilingual field names.', 'Provider usage fields are not billing estimates.'] }
writeFileSync(resolve(dir, 'full-test-audit.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

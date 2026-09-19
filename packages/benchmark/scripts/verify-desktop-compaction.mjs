#!/usr/bin/env node
// Offline replay against installed Desktop modules. Does not contact a model,
// mutate the live session/store, or need login/API credentials.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [rootArg, runArg] = process.argv.slice(2)
if (!rootArg || !runArg) throw new Error('Usage: node verify-desktop-compaction.mjs HARNESS_PACKAGE_ROOT RUN_DIR')
const root = resolve(rootArg), dir = resolve(runArg)
process.env.REMI_DSH_PACKAGE_ROOT = root
const require = createRequire(resolve(root, 'package.json'))
const hostImport = name => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await hostImport('@deepseek-ai/cordis')
const { Session } = await hostImport('@deepseek-ai/dsh-session')
const { TokenMeter } = await hostImport('@deepseek-ai/dsh-token-meter')
const { DshSelectiveMemory } = await import('../../dsh-adapter/dist/index.js')
const { COMPACTION_BACKEND } = await import('../../dsh-adapter/dist/compaction-backend.js')
const snapshot = JSON.parse(readFileSync(resolve(dir, 'initial-snapshot.json'), 'utf8'))
const seed = [...snapshot.records.map(r => r.event), ...readFileSync(resolve(dir, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse)]
assert(seed.every((e, i) => e.seq === i), 'Replay must be contiguous')
const session = new Session(snapshot.header.id, seed, snapshot.header)
const ctx = new Context()
ctx.provide('systemPrompt', { section() {} })
ctx.provide('llm', { imageRequestPricing() { return undefined }, stream() { throw new Error('Model calls are forbidden in offline verification') } })
let flushes = 0
ctx.provide('sessions', { async flush() { flushes++ } })
const meter = new TokenMeter(ctx)
const plugin = new DshSelectiveMemory(ctx, { databasePath: ':memory:', telemetryEnabled: false, autoCompaction: false, compactionSummaryTokenBudget: 600 })
const original = seed.find(e => e.type === 'user/message' && e.data.source.kind === 'user')
const injected = seed.find(e => e.type === 'user/message' && e.data.source.kind === 'plugin' && JSON.stringify(e.data.content).includes('<memory-context'))
assert(original && injected)
ctx.emit('session/event', session, original)
ctx.emit('session/event', session, injected)
await plugin.pendingObservation
assert.equal((await plugin.store.stats()).memories, 1, 'Observer must retain only the original conversation event')
const signal = new AbortController().signal
const agent = { session, runMaintenance: async work => work(signal) }
const before = meter.measure(session)
const generation = session.surface.replaceGeneration
const result = await plugin.compactNow(agent, signal, 'offline-replay-verification')
assert(result, 'Expected a nonempty compaction result')
assert.equal(session.surface.replaceGeneration, generation + 1)
const replacement = session.events.findLast(e => e.type === 'user/message' && typeof e.surfaceOp === 'object')
assert(replacement, 'Replacement must be durably appended')
assert.deepEqual(Object.keys(replacement.surfaceOp).sort(), ['end', 'op', 'start'])
const summary = session.events.findLast(e => e.type === 'compaction/summary')
assert(!JSON.stringify(summary.data.summary).includes('<memory-context'), 'Summary must not contain injected windows')
assert.equal(session.events.findLast(e => e.type === 'compaction/end').data.error, undefined)
const report = { mode: 'offline-replay-not-live-model-evaluation', backend: COMPACTION_BACKEND, seedEvents: seed.length, beforeTokens: before.totalTokens, afterTokens: meter.measure(session).totalTokens, generationIncrement: 1, replacementShape: Object.keys(replacement.surfaceOp).sort(), summaryExcludesRuntimeWindows: true, observerExcludesRuntimeWindows: true, flushes, modelCalls: 0 }
writeFileSync(resolve(dir, 'desktop-compaction-verification.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
await ctx.fiber.dispose()

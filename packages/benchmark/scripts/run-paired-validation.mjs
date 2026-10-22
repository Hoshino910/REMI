#!/usr/bin/env node
// Opt-in, single-arm local DSH runner. No model endpoint or credentials are embedded.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { assertPlan } from '../dist/validation.js'

const [planFile, configFile, ...args] = process.argv.slice(2)
if (!planFile || !configFile) throw new Error('Usage: run-paired-validation.mjs plan.json local-config.json --variant=full --seed=0 --repeat=0 [--execute]')
const option = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const plan = JSON.parse(readFileSync(planFile, 'utf8'))
assertPlan(plan)
const config = JSON.parse(readFileSync(configFile, 'utf8'))
const variant = option('variant', 'full')
const seed = Number(option('seed', '0'))
const repetition = Number(option('repeat', '0'))
const testCase = plan.cases.find(item => item.seed === seed)
const arm = config.variants?.[variant]
if (!testCase || !plan.variants.includes(variant) || !Number.isInteger(repetition) || repetition < 0 || repetition >= plan.repetitions || !arm?.preset) throw new Error('Invalid seed, repetition, variant or preset mapping')
const maxPrompts = config.maxPrompts ?? 128
const prompts = testCase.steps.filter(step => step.kind === 'prompt').length
if (!Number.isInteger(maxPrompts) || maxPrompts < 1 || prompts > maxPrompts) throw new Error('Run exceeds configured maxPrompts')
if (!args.includes('--execute')) {
  console.log(JSON.stringify({ status: 'prepared-only', variant, seed, repetition, prompts, preset: arm.preset,
    corpusSha256: plan.corpusSha256, required: ['local DSH preset', 'independent usage meter in all arms', 'REMI_DSH_LOGIN_URL', 'REMI_DSH_INSTALL'],
    note: 'No network or model requests made. --execute runs one arm.' }, null, 2))
  process.exit(0)
}

const login = new URL(process.env.REMI_DSH_LOGIN_URL ?? '')
if (login.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(login.hostname)) throw new Error('Only a one-time local HTTP DSH login is supported')
const install = process.env.REMI_DSH_INSTALL
if (!install || !config.meterPath) throw new Error('REMI_DSH_INSTALL and config.meterPath are required')
const require = createRequire(resolve(install, 'package.json'))
const WebSocket = require('ws')
const { foldSurface, deriveEventMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href)
const sessionId = `remi-validation-${randomUUID()}`
const runDirectory = resolve(config.outputDirectory ?? '.dsh-memory/paired', sessionId)
mkdirSync(runDirectory, { recursive: true })
const run = { variant, seed, repetition, corpusSha256: plan.corpusSha256, modelConfigSha256: '',
  status: 'failed', answers: [], calls: [], providerUsageReconciled: false, heldoutSurfaceVerified: false }
const progress = { sessionId, baseCommit: plan.baseCommit, startedAt: new Date().toISOString(), completedPrompts: 0, controls: [], surfaceGate: null }
const save = () => {
  writeFileSync(resolve(runDirectory, 'run.json'), JSON.stringify(run, null, 2), { mode: 0o600 })
  writeFileSync(resolve(runDirectory, 'progress.json'), JSON.stringify(progress, null, 2), { mode: 0o600 })
}
const meterPath = resolve(config.meterPath)
const meterStart = existsSync(meterPath) ? readFileSync(meterPath, 'utf8').split(/\r?\n/).filter(Boolean).length : 0
let cookie, socket, pending
let rpcId = 0
let streamFailure
const observed = new Map()
let readyResolve, readyReject
const ready = new Promise((yes, no) => { readyResolve = yes; readyReject = no })
const rpc = async (method, payload, timeout = 15000) => {
  const response = await fetch(`${login.origin}/api/${method}`, {
    method: 'POST', headers: { Cookie: cookie, Origin: login.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `paired-${++rpcId}`, method, payload: { args: payload } }),
    signal: AbortSignal.timeout(timeout),
  })
  if (!response.ok) throw new Error(`Local RPC ${method}: HTTP ${response.status}`)
  const wire = await response.json()
  if (!wire.result?.ok) throw new Error(`Local RPC ${method}: ${wire.result?.error?.code ?? 'failed'}`)
  return wire.result.value
}
const fail = message => {
  streamFailure = message
  readyReject(new Error(message))
  if (pending) { const current = pending; pending = undefined; clearTimeout(current.timer); current.reject(new Error(message)) }
}
const ingest = event => {
  observed.set(event.seq, event)
  appendFileSync(resolve(runDirectory, 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 })
  if (!pending) return
  if (event.type === 'llm/retry' || /^tool\//.test(event.type)) { fail('Retry or unexpected tool event observed; no driver resubmission'); void rpc('session/cancel', { request: { sessionId } }).catch(() => {}); return }
  if (event.type === 'assistant/message') {
    const blocks = event.data?.message?.content ?? []
    if (blocks.some(block => block.type === 'tool-call')) { fail('Unexpected tool call'); return }
    pending.answer = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
  }
  if (event.type === 'turn/end') {
    const current = pending; pending = undefined; clearTimeout(current.timer)
    if (event.data?.reason?.kind === 'error' || !current.answer) current.reject(new Error('Failed or empty model answer'))
    else current.resolve(current.answer)
  }
}

console.log(`RUN_DIRECTORY ${runDirectory}`)
save()
try {
  const response = await fetch(login, { redirect: 'manual', signal: AbortSignal.timeout(15000) })
  if (response.status !== 303) throw new Error('Fresh local login link required')
  cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  if (!cookie) throw new Error('Local login did not return a cookie')
  delete process.env.REMI_DSH_LOGIN_URL
  await rpc('session/create', { request: { sessionId, agentPreset: arm.preset, cwd: process.cwd() } })
  socket = new WebSocket(`${login.origin.replace('http:', 'ws:')}/api/remote.mux`, { headers: { Cookie: cookie, Origin: login.origin } })
  socket.on('open', () => socket.send(JSON.stringify({ type: 'open', streamId: 'paired-follow', endpoint: 'session/follow',
    payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 5000 } } } })))
  socket.on('error', () => fail('Event stream error'))
  socket.on('close', () => { if (run.status !== 'complete') fail('Event stream closed') })
  socket.on('message', buffer => {
    try {
      const frame = JSON.parse(buffer.toString())
      if (frame.type === 'error') { fail('DSH event stream rejected subscription'); return }
      if (frame.type !== 'item') return
      if (frame.value.type === 'snapshot') {
        for (const record of frame.value.records ?? []) if (record.type === 'event') observed.set(record.event.seq, record.event)
        readyResolve()
      } else if (frame.value.type === 'event') ingest(frame.value.event)
    } catch { fail('Malformed local event stream') }
  })
  let readyTimer
  try { await Promise.race([ready, new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error('Snapshot timeout')), 15000) })]) }
  finally { clearTimeout(readyTimer) }
  for (const step of testCase.steps) {
    if (streamFailure) throw new Error(streamFailure)
    if (step.kind === 'compact') {
      if (variant === 'no_plugin') { progress.controls.push({ stepId: step.id, skipped: 'raw-history baseline' }); save(); continue }
      const result = await rpc('commands/execute', { agentId: sessionId, line: '/compact', images: [] }, 180000)
      progress.controls.push({ stepId: step.id, result })
      if (result?.result?.kind !== 'success') throw new Error('Compaction command did not succeed')
      save(); continue
    }
    if (step.phase === 'recall-after' && variant !== 'no_plugin') {
      const events = [...observed.values()].sort((a, b) => a.seq - b.seq)
      if (!events.every((event, index) => event.seq === index)) throw new Error('Incomplete active-surface evidence')
      const { nodes } = foldSurface(events)
      const messages = nodes.map(seq => deriveEventMessage(events[seq])).filter(Boolean)
      const activeText = messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
      const compacted = events.filter(event => event.type === 'compaction/end' && !event.data?.error).length
      run.heldoutSurfaceVerified = compacted >= 2 && !activeText.includes(step.expected)
      progress.surfaceGate = { activeNodes: nodes.length, successfulCompactions: compacted, heldoutAnswerAbsent: !activeText.includes(step.expected) }
      writeFileSync(resolve(runDirectory, 'heldout-surface.json'), JSON.stringify({ nodes, messages }), { mode: 0o600 })
      save()
      // Finish recording failures transparently; an ungated run cannot establish savings.
    }
    let current
    const ended = new Promise((yes, no) => {
      current = { answer: '', resolve: yes, reject: no, timer: setTimeout(() => { pending = undefined; no(new Error('Model turn timeout; no resubmission')) }, config.turnTimeoutMs ?? 180000) }
      pending = current
    }).then(answer => ({ answer }), error => ({ error }))
    try {
      await rpc('session/prompt', { request: { requestId: `paired-${randomUUID()}`, sessionId, mode: 'queue',
        content: [{ type: 'text', text: step.text }], clientTimeZone: 'Asia/Shanghai' } })
    } catch (error) { clearTimeout(current.timer); pending = undefined; throw error }
    const result = await ended
    if (result.error) throw result.error
    run.answers.push({ stepId: step.id, answer: result.answer })
    progress.completedPrompts += 1
    save(); console.log(`DONE ${progress.completedPrompts}/${prompts} ${step.phase}`)
  }
  run.status = 'complete'
} catch (error) {
  // Do not persist arbitrary provider messages that may echo URLs/credentials.
  progress.failure = error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[url]').replace(/token=[^\s&]+/g, 'token=[redacted]') : 'Run failed'
  if (cookie) try { await rpc('session/cancel', { request: { sessionId } }) } catch {}
  process.exitCode = 1
} finally {
  if (pending) { clearTimeout(pending.timer); pending = undefined }
  socket?.removeAllListeners(); socket?.close()
  const rows = existsSync(meterPath) ? readFileSync(meterPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(meterStart).map(line => JSON.parse(line)) : []
  const own = rows.filter(row => row.sessionId === sessionId)
  const ambiguous = rows.filter(row => row.sessionId === null)
  run.calls = own.filter(row => row.usage).map(row => ({ callId: row.callId, provider: row.provider, model: row.model, stage: row.stage, ...row.usage }))
  const mainConfigs = new Set(own.filter(row => row.stage === 'answer').map(row => row.modelConfigSha256).filter(Boolean))
  run.modelConfigSha256 = mainConfigs.size === 1 ? [...mainConfigs][0] : ''
  progress.usageCoverage = { observedCalls: own.length, callsWithSingleUsageEvent: run.calls.length, unassignedCalls: ambiguous.length,
    providerUsageReconciled: false, note: 'Reconcile retries, title calls and all auxiliary requests against provider records before scoring cost.' }
  progress.finishedAt = new Date().toISOString()
  save()
  console.log(JSON.stringify({ status: run.status, runDirectory, modelCalls: own.length, costEvidence: 'unreconciled' }))
}

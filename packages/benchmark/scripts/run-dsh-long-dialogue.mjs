#!/usr/bin/env node
// Opt-in local DSH driver. No remote provider credentials are read or persisted.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = resolve(process.argv[2] ?? '.dsh-memory/long-dialogue-v02')
if (!process.env.REMI_DSH_LOGIN_URL) throw new Error('REMI_DSH_LOGIN_URL is required and must be a one-time local DSH login URL')
const login = new URL(process.env.REMI_DSH_LOGIN_URL)
if (!['127.0.0.1', 'localhost'].includes(login.hostname) || login.protocol !== 'http:') throw new Error('Only local HTTP DSH is supported')
const base = login.origin
const install = process.env.REMI_DSH_INSTALL
if (!install) throw new Error('REMI_DSH_INSTALL must point to the local DSH resources/app.asar.unpacked directory')
const require = createRequire(resolve(install, 'package.json'))
const WebSocket = require('ws')
const corpus = readFileSync(resolve(dir, 'messages.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse)
if (corpus.filter(s => s.stage !== 'control').length !== 114) throw new Error('Unexpected corpus size')
const resumeId = process.argv.find(a => a.startsWith('--resume-session='))?.slice('--resume-session='.length)
const preset = process.argv.find(a => a.startsWith('--preset='))?.slice('--preset='.length) ?? 'remi-v02-test'
const cleanDbArg = process.argv.find(a => a.startsWith('--clean-db='))?.slice('--clean-db='.length)
const cleanDb = cleanDbArg ? resolve(cleanDbArg) : undefined
if (cleanDb && (resumeId || existsSync(cleanDb))) throw new Error('Clean-room requires a new session and a database file that does not exist')
const messages = resumeId ? corpus.filter(s => ['control', 'recall-after-compaction', 'unknown-control'].includes(s.stage)) : corpus
const totalPrompts = messages.filter(s => s.stage !== 'control').length
const { foldSurface, deriveEventMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href)
const runDir = resolve(dir, `run-${Date.now()}`)
mkdirSync(runDir, { recursive: true })
const sessionId = resumeId ?? `session-remi-long-${Date.now()}`
const report = { sessionId, preset, startedAt: new Date().toISOString(), status: 'initializing', acceptedPrompts: 0, completedPrompts: 0, commands: [], turns: [] }
if(cleanDb) report.cleanRoom = { databasePath:cleanDb, databaseFileExistedBeforeSession:false }
report.fixture = JSON.parse(readFileSync(resolve(dir,'manifest.json'),'utf8')).fixture
const save = () => writeFileSync(resolve(runDir, 'progress.json'), JSON.stringify(report, null, 2))
console.log(`RUN_DIR ${runDir}`)
save()
let cookie, socket, pending, readyResolve, readyReject, dead = false
let rpcCounter = 0
const observedEvents = new Map()
const seedRun = process.argv.find(a=>a.startsWith('--seed-run='))?.slice('--seed-run='.length)
if(resumeId && seedRun) {
  const seedSnapshot = JSON.parse(readFileSync(resolve(seedRun,'initial-snapshot.json'),'utf8'))
  if(seedSnapshot.header.id !== resumeId) throw new Error('Seed belongs to another session')
  for(const r of seedSnapshot.records) if(r.type==='event')observedEvents.set(r.event.seq,r.event)
  for(const e of readFileSync(resolve(seedRun,'events.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse))observedEvents.set(e.seq,e)
}
const streamReady = new Promise((r,j) => { readyResolve = r; readyReject = j })
async function rpc(method, args, timeout = 180_000) {
  const response = await fetch(`${base}/api/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base }, body: JSON.stringify({type:'client-request',rpcId:`remi-long-rpc-${++rpcCounter}`,method,payload:{args}}), signal: AbortSignal.timeout(timeout) })
  if (!response.ok) throw new Error(`Local RPC ${method}: HTTP ${response.status}`)
  const wire = await response.json()
  if (!wire.result?.ok) {
    const error = wire.result?.error
    report.localError = {method,code:error?.code,message:String(error?.message ?? '').replace(/token=[^\s&]+/g,'token=[REDACTED]')}
    save()
    throw new Error(`Local RPC ${method}: ${error?.code ?? 'failed'} ${report.localError.message}`)
  }
  return wire.result.value
}
function failStream(reason) {
  dead = true
  readyReject(new Error(reason))
  if (pending) { clearTimeout(pending.timer); pending.reject(new Error(reason)); pending = undefined }
}
function ingest(event) {
  observedEvents.set(event.seq, event)
  appendFileSync(resolve(runDir, 'events.jsonl'), JSON.stringify(event) + '\n')
  if (!pending) return
  if (event.type === 'llm/retry') {
    // The driver never resubmits a prompt. Also cancel DSH's separately owned
    // retry scheduler as soon as its first scheduling event is observable.
    const current = pending
    clearTimeout(current.timer)
    pending = undefined
    report.internalRetryScheduled = true
    void rpc('session/cancel', {request:{sessionId}}, 15_000).catch(()=>{})
    current.reject(new Error('DSH scheduled an internal retry; cancellation requested; no prompt resubmitted'))
    return
  }
  if (event.type === 'assistant/message') {
    const content = event.data?.message?.content ?? []
    pending.answer = content.filter(b=>b.type==='text').map(b=>b.text).join('\n')
    if (content.some(b=>b.type==='tool-call')) { pending.reject(new Error('Unexpected tool call; test halted')); clearTimeout(pending.timer); pending = undefined; return }
  }
  if (/^tool\//.test(event.type)) { pending.reject(new Error('Unexpected tool event; test halted')); clearTimeout(pending.timer); pending = undefined; return }
  if (event.type === 'step/end') pending.stepEnd = event.data
  if (event.type === 'request/context') pending.route = {model:event.data.model,contextWindow:event.data.contextWindow}
  if (event.type === 'turn/end') {
    clearTimeout(pending.timer)
    const current = pending
    pending = undefined
    if (event.data?.reason?.kind === 'error') current.reject(new Error(`Model turn failed: ${event.data.reason.error?.code ?? 'unknown'}; no retry`))
    else if (!current.answer) current.reject(new Error('Turn ended without a text answer; no retry'))
    else current.resolve({answer:current.answer,end:event.data,stepEnd:current.stepEnd,route:current.route,endSeq:event.seq})
  }
}
try {
  const response = await fetch(login, {redirect:'manual', signal:AbortSignal.timeout(15_000)})
  if (response.status !== 303) throw new Error(`Local login HTTP ${response.status}; fresh login link required`)
  cookie = response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')
  if (!cookie) throw new Error('Local login did not issue a cookie')
  delete process.env.REMI_DSH_LOGIN_URL
  if (!resumeId) {
    await rpc('session/create', {request:{sessionId,agentPreset:preset,cwd:process.cwd()}})
    if(cleanDb) {
      if(!existsSync(cleanDb))throw new Error('Configured clean database was not initialized; check preset path')
      const database = new DatabaseSync(cleanDb,{readOnly:true})
      const counts = Object.fromEntries(['memories','retrieval_traces','memory_associations'].map(table=>[table,Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n)]))
      database.close()
      report.cleanRoom = {...report.cleanRoom,checkedAt:new Date().toISOString(),beforeFirstPrompt:counts}
      save()
      console.log(`CLEAN_ROOM ${JSON.stringify(counts)}`)
      if(Object.values(counts).some(n=>n!==0))throw new Error('Clean-room database is not empty; no model prompts sent')
    }
    await rpc('session/rename', {request:{sessionId,title:cleanDb ? 'REMI v0.2 独立空库长测 V3（新约定·96轮干扰）' : report.fixture.endsWith('-fresh') ? 'REMI v0.2 全新长测（96轮干扰·排序修复后）' : 'REMI v0.2 超长对话验收（96轮干扰）'}})
  }
  else {
    // Official create-or-adopt resumes the persisted Agent without a model turn.
    await rpc('session/create', {request:{sessionId,agentPreset:preset,cwd:process.cwd()}})
  }
  socket = new WebSocket(`${base.replace('http:','ws:')}/api/remote.mux`, {headers:{Cookie:cookie,Origin:base}})
  socket.on('open',()=>socket.send(JSON.stringify({type:'open',streamId:'long-follow',endpoint:'session/follow',payload:{args:{request:{address:{kind:'session',sessionId},maxMessages:5000}}}})))
  socket.on('error',()=>failStream('Local event stream error; no retry'))
  socket.on('close',()=>{if(report.status!=='complete'&&report.status!=='stopped')failStream('Local event stream closed; no retry')})
  socket.on('message',buffer=>{
    const frame = JSON.parse(buffer.toString())
    if(frame.type==='error') {failStream(`Local event stream: ${frame.error?.code ?? 'failed'}`);return}
    if(frame.type!=='item')return
    const value=frame.value
    if(value.type==='snapshot') {
      writeFileSync(resolve(runDir,'initial-snapshot.json'),JSON.stringify(value))
      for(const record of value.records ?? []) if(record.type==='event') observedEvents.set(record.event.seq,record.event)
      readyResolve()
    }
    if(value.type==='event')ingest(value.event)
  })
  await Promise.race([streamReady,new Promise((_,j)=>setTimeout(()=>j(new Error('Event snapshot timeout')),15_000))])
  report.status='running'; save()
  for(const message of messages) {
    if(dead)throw new Error('Event stream unavailable')
    if(message.stage==='control') {
      const result=await rpc('commands/execute',{agentId:sessionId,line:'/compact',images:[]})
      report.commands.push({index:message.index,result})
      save()
      console.log(`COMPACT ${JSON.stringify(result)}`)
      if(result?.result?.kind!=='success')throw new Error('Compaction command failed; no retry')
      {
        const events = [...observedEvents.values()].sort((a,b)=>a.seq-b.seq)
        if(!events.every((e,i)=>e.seq===i))throw new Error('Incomplete surface evidence; recall withheld')
        const {nodes} = foldSurface(events)
        const active = nodes.map(seq=>deriveEventMessage(events[seq])).filter(Boolean)
        const activeText = active.flatMap(m=>m.content.filter(b=>b.type==='text').map(b=>b.text)).join('\n')
        const anchors = corpus.filter(s=>s.stage==='anchor').slice(4)
        const stillOriginal = anchors.filter(a=>activeText.normalize('NFKC').includes(a.text.normalize('NFKC'))).map(a=>a.index)
        const heldout = JSON.parse(readFileSync(resolve(dir,'ground-truth.json'),'utf8')).slice(4)
        const fieldsVisible = heldout.map(t=>({target:t.target,fields:Object.values(t.expected).map(v=>({value:v,visible:activeText.includes(String(v))}))}))
        report.surfaceGate = {activeNodes:nodes.length,heldoutOriginalAnchorsStillVisible:stillOriginal,heldoutFieldsVisible:fieldsVisible,compactionEnds:events.filter(e=>e.type==='compaction/end').map(e=>({seq:e.seq,error:e.data.error})),replacementCount:events.filter(e=>e.type==='user/message'&&typeof e.surfaceOp==='object').length}
        writeFileSync(resolve(runDir,'post-compaction-surface.json'),JSON.stringify({nodes,messages:active},null,2))
        save()
        if(stillOriginal.length || !report.surfaceGate.replacementCount)throw new Error('Held-out original facts remain on surface; recall withheld')
      }
      continue
    }
    const started = Date.now()
    const ended = new Promise((resolveTurn,rejectTurn)=>{
      pending={answer:'',resolve:resolveTurn,reject:rejectTurn,timer:setTimeout(()=>{pending=undefined;rejectTurn(new Error('Model turn timeout after 180 seconds; no retry'))},180_000)}
    })
    // Attach handler before local acceptance to avoid unhandled rejections.
    const turnOutcome = ended.then(value=>({value}),error=>({error}))
    await rpc('session/prompt',{request:{requestId:`remi-long-${sessionId}-${message.index}`,sessionId,mode:'queue',content:[{type:'text',text:message.text}],clientTimeZone:'Asia/Shanghai'}})
    report.acceptedPrompts++; report.currentIndex=message.index; report.currentStage=message.stage; save()
    const result = await turnOutcome
    if(result.error)throw result.error
    report.completedPrompts++
    report.turns.push({index:message.index,stage:message.stage,target:message.target,chars:message.text.length,durationMs:Date.now()-started,...result.value})
    save()
    console.log(`DONE ${report.completedPrompts}/${totalPrompts} ${message.stage}${message.round ? ` ${message.round}/96` : ''} ${Date.now()-started}ms`)
  }
  report.status='complete'; report.finishedAt=new Date().toISOString(); save()
  console.log('LONG_TEST_COMPLETE')
} catch(error) {
  report.status='stopped'; report.finishedAt=new Date().toISOString(); report.reason=String(error.message).replace(/token=[^\s&]+/g,'token=[REDACTED]'); save()
  console.log(`LONG_TEST_STOPPED ${report.reason}`)
  if(pending){clearTimeout(pending.timer);pending=undefined}
  if(cookie&&report.acceptedPrompts>report.completedPrompts)try{await rpc('session/cancel',{request:{sessionId}},15_000)}catch{}
  process.exitCode=1
} finally {
  if(socket){socket.removeAllListeners();socket.close()}
}

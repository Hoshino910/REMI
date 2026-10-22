#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { SqliteMemoryStore } from '@dsh-memory/store-sqlite'
import { MemoryManager, parseManagerRequest } from './index.js'

const args = process.argv.slice(2)
const databaseIndex = args.indexOf('--db')
const filename = args[databaseIndex + 1]
if (databaseIndex < 0 || !filename || args.includes('--help')) {
  console.error('Usage: remi-memory --db <sqlite-path> [--create] [--write] < request.json\nJSON requests: status, bind, list, recall, write, revise, forget, export, consolidation-preview')
  process.exitCode = args.includes('--help') ? 0 : 2
} else {
  let store: SqliteMemoryStore | undefined
  try {
    const request = parseManagerRequest(JSON.parse(readFileSync(0, 'utf8')))
    if (!existsSync(filename) && !args.includes('--create')) throw new Error('Database does not exist; pass --create to initialize explicitly')
    store = new SqliteMemoryStore({ filename })
    console.log(JSON.stringify(await new MemoryManager(store).execute(request, args.includes('--write')), null, 2))
  } catch (error: unknown) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'Manager request failed' }))
    process.exitCode = 1
  } finally { await store?.close() }
}

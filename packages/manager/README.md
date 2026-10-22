# Local REMI management

`MemoryManager` is a reusable service over the same SQLite/runtime implementation as the DSH plugin. It provides explicit-ID write/revision/forget, inspect/export, read-only recall previews and deterministic consolidation proposals. It is not a separate memory system or hosted web service.

Build once at the repository root, then in PowerShell:

```powershell
pnpm install --frozen-lockfile
pnpm build
Get-Content examples/validation/manager-write.json -Raw | node packages/manager/dist/cli.js --db C:/remi-validation/demo.sqlite --create --write
Get-Content examples/validation/manager-recall.json -Raw | node packages/manager/dist/cli.js --db C:/remi-validation/demo.sqlite
```

Each invocation reads ONE JSON request on stdin and writes JSON on stdout. A nonexistent database requires `--create`; mutation requires `--write`. Opening an existing database runs its forward-compatible additive migration. Back up the database with DSH stopped before using a new version.

Request examples (one per invocation):

```json
{"operation":"status"}
```
```json
{"operation":"bind","sessionId":"s2","scope":{"ownerId":"local-owner","projectId":"REMI"}}
```
```json
{"operation":"list","sessionId":"example-session","includeInactive":true}
```
```json
{"operation":"recall","request":{"sessionId":"s2","scope":"project","query":"Cedar service port","tokenBudget":400}}
```
```json
{"operation":"revise","sessionId":"example-session","targetMemoryId":"COPY_REAL_ID_FROM_LIST","content":"The Cedar service port is 9361.","timestamp":1792627201000}
```
```json
{"operation":"forget","request":{"sessionId":"example-session","memoryIds":["COPY_REAL_ID_FROM_LIST"],"mode":"delete","includeRevisions":true}}
```
```json
{"operation":"consolidation-preview","sessionId":"example-session"}
```
```json
{"operation":"export","sessionId":"example-session","includeInactive":true,"limit":10000}
```

`exclude` retains a quarantined record; `delete` creates a lifecycle tombstone; `purge` also clears the stored row's text/embedding/affect/metadata. All three remove incident Hebbian edges and block exact normalized-content re-ingestion. Revision chains are included by default, including explicitly bound sessions in the same project. Invalid targets roll back the entire batch. `purge` is logical scrubbing, not physical secure erasure of SQLite free pages, WAL, host logs, exports, backups or provider history. Stable non-cryptographic content fingerprints remain for replay suppression.

Recall previews do not touch access counters, insert traces or reinforce the graph. Consolidation only proposes exact normalized duplicates for review. It does not claim LLM semantic consolidation. Exports contain raw memory text and are capped; check `mayBeTruncated` before treating an export as complete. No import/restore command is implemented yet.

The local manager is a trusted operator interface; scope bindings are isolation metadata, not multi-user authentication. No HTTP listener or model-accessible delete tool is registered. A native DSH management page can reuse this service after compatibility testing.

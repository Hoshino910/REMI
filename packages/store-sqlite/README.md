# @dsh-memory/store-sqlite

SQLite implementation of `MemoryStore` built on Node.js `node:sqlite`. It stores raw memory content, bounded affect hints, retrieval traces, and decaying association edges locally.

Framework schema v4 adds `session_scopes` and `content_tombstones`. Host-supplied owner/project bindings are immutable and opt-in. Project reads filter by both fields before LIMIT. `supersede()` can cross sessions only within an explicitly bound owner/project, and `forget()` atomically processes revision chains and removes incident graph edges.

Association `session_id` is now an internal namespace: `session:<JSON session ID>` or `project:<JSON [owner, project]>`. A transactional one-time migration preserves old session edges. The API still returns the requesting session ID; consumers must not interpret the underlying graph namespace as a DSH session ID. `hebbianMaxEdgesPerSession` bounds each active graph namespace.

Exact normalized-content tombstones prevent replay into ingestion/REMI compaction. `purge` scrubs row text, embedding, affect and metadata, but is not secure physical erasure or deletion from host/provider logs. Back up an inactive database before upgrading; restore that backup when rolling back to an older plugin. See the [manager guide](../manager/README.md) and [audit](../../docs/AUDIT_2026-10-22.zh-CN.md).

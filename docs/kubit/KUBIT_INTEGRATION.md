# Kubit Integration

This document describes the Kubit integration added to Langfuse. It enables automatic, scheduled export of traces, observations, and scores from Langfuse to a configurable Kubit ingest endpoint.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Langfuse Web                                                       │
│                                                                     │
│  /settings/integrations/kubit  ──►  kubitIntegrationRouter         │
│                                         │                           │
│                              ┌──────────┘                          │
│                              │  PostgreSQL                          │
│                              │  kubit_integrations table           │
│                              │  (endpoint_url, encrypted_api_key,  │
│                              │   enabled, sync_interval_minutes,   │
│                              │   session_offset_minutes,           │
│                              │   request_timeout_seconds,          │
│                              │   last_sync_at)                     │
└──────────────────────────────┼──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│  Langfuse Worker                                                    │
│                                                                     │
│  ┌─────────────────────────────────────────────────────┐           │
│  │  KubitIntegrationQueue  (cron: every 15 min)        │           │
│  │  └─► handleKubitSchedule                            │           │
│  │        • Query all enabled integrations from PG     │           │
│  │        • Filter to those due (syncIntervalMinutes   │           │
│  │          elapsed since lastSyncAt)                  │           │
│  │        • Enqueue one job per project ───────────────┼──┐        │
│  │          into KubitIntegrationProcessingQueue       │  │        │
│  └─────────────────────────────────────────────────────┘  │        │
│                                                            │        │
│  ┌─────────────────────────────────────────────────────◄──┘        │
│  │  KubitIntegrationProcessingQueue  (per-project job) │           │
│  │  └─► handleKubitProjectJob                          │           │
│  │        • Load config + decrypt API key from PG      │           │
│  │        • Stream traces, observations, scores        │           │
│  │          from ClickHouse (window:                   │           │
│  │          lastSyncAt → now - sessionOffsetMinutes)   │           │
│  │        • KubitClient: size-based batching (8 MB)    │           │
│  │          POST → configured endpoint URL             │           │
│  │        • On success: update lastSyncAt in PG        │           │
│  └─────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────┘
                               │
                               │  HTTPS POST
                               │  Authorization: Bearer <api_key>
                               │  { "events": [ { "entity_type": "...", ... } ] }
                               ▼
                      Kubit Ingest Endpoint
```

---

## Changed / Added Files

### `packages/shared/prisma/migrations/20260311000000_add_kubit_integration/migration.sql`
**New file — database schema**

Creates the `kubit_integrations` table in PostgreSQL. One row per project, keyed on `project_id` (FK → `projects` with `ON DELETE CASCADE`).

| Column | Type | Purpose |
|---|---|---|
| `project_id` | TEXT PK | Ties the integration to a Langfuse project |
| `endpoint_url` | TEXT | Where to POST data |
| `encrypted_api_key` | TEXT | AES-encrypted Bearer token |
| `enabled` | BOOLEAN | Toggle sync on/off without deleting config |
| `sync_interval_minutes` | INT (default 60) | How often to sync per project |
| `session_offset_minutes` | INT (default 30) | Lag behind "now" to avoid partial sessions |
| `request_timeout_seconds` | INT (default 30) | HTTP timeout for each batch request |
| `last_sync_at` | TIMESTAMP | High-water mark; updated after every successful sync |

---

### `packages/shared/src/server/queues.ts`
**Modified — adds Kubit queue types**

Registers two new queues following the existing pattern used by the Mixpanel and Blob Storage integrations:

- **`KubitIntegrationQueue`** — scheduler queue (cron-triggered, decides which projects to sync)
- **`KubitIntegrationProcessingQueue`** — per-project processing queue (performs the actual data export)

Adds corresponding `QueueName` and `QueueJobs` enum values, plus `TQueueJobTypes` entries for type-safe job payloads.

---

### `packages/shared/src/server/redis/kubitIntegrationQueue.ts`
**New file — scheduler queue**

Singleton queue that fires a cron job every 15 minutes (`*/15 * * * *`). The 15-minute cadence is intentionally finer than the default 60-minute sync interval so projects with different `syncIntervalMinutes` are all checked regularly. The actual due-check is done in `handleKubitSchedule`.

---

### `packages/shared/src/server/redis/kubitIntegrationProcessingQueue.ts`
**New file — per-project processing queue**

Singleton queue for per-project sync jobs. Configured with:
- **5 retry attempts** with exponential backoff (5s base)
- `removeOnComplete: true` to keep Redis clean
- `removeOnFail: 100_000` to retain failed jobs for debugging

---

### `packages/shared/src/server/repositories/traces.ts` / `observations.ts` / `scores.ts`
**Modified — adds ClickHouse streaming queries**

Adds one async generator per entity type (`getTracesForKubit`, `getObservationsForKubit`, `getScoresForKubit`). Each:
- Queries ClickHouse via `queryClickhouseStream` (memory-efficient, no full result set loaded at once)
- Filters by `project_id`, timestamp window, and `is_deleted = 0`
- Yields rows tagged with `entity_type` so the downstream client can distinguish them

---

### `web/src/features/kubit-integration/types.ts`
**New file — validation schema**

Defines `kubitIntegrationFormSchema`. Validates all user-configurable fields. Shared between the frontend form and the API router to avoid duplication.

---

### `web/src/features/kubit-integration/kubit-integration-router.ts`
**New file — API router**

Three procedures, all behind the `integrations:CRUD` RBAC scope:

| Procedure | What it does |
|---|---|
| `get` | Reads integration config for a project. The API key is **never returned** — only metadata. |
| `update` | Creates or updates the integration. The API key is AES-encrypted before storage using `ENCRYPTION_KEY`. If a row already exists and no new API key is provided, the existing encrypted key is preserved. |
| `delete` | Deletes the integration row, disabling sync. |

All mutations write an audit log entry.

---

### `web/src/pages/project/[projectId]/settings/integrations/kubit.tsx`
**New file — settings UI page**

Settings page at `/project/[projectId]/settings/integrations/kubit`. Access is restricted to users with the `integrations:CRUD` scope (project admin or owner).

The page has three sections:

**Header**
- Status badge showing **active** or **inactive** based on the `enabled` flag

**Configuration form**

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| Endpoint URL | Text | `https://langfuse-ingest.kubit.ai` | Must be a valid URL | The full ingest URL of the Kubit instance |
| API Key | Password | — | Required on first save; leave blank to keep existing | Bearer token for authenticating with the endpoint. Never pre-filled, never returned by the API. |
| Sync Interval | Number | 60 | min 15, max 1440 | How often (in minutes) data is synced to Kubit |
| Session Offset | Number | 30 | min 5, max 120 | How far behind "now" to sync — increase if sessions last longer than 30 minutes |
| Request Timeout | Number | 30 | min 5, max 300 | Seconds to wait for a response before retrying |
| Enabled | Toggle | off | — | Enables or disables the sync without deleting the configuration |

**Status section** (shown only when enabled)
- Displays `lastSyncAt` — the timestamp of the most recently completed sync

**Actions**
- **Save** — creates or updates the integration
- **Reset** — deletes the integration row entirely (requires confirmation)

---

### `worker/src/queues/kubitQueue.ts`
**New file — queue processors**

Wires up two processors:
- `kubitIntegrationProcessor` → handles `KubitIntegrationJob` → calls `handleKubitSchedule`
- `kubitIntegrationProcessingProcessor` → handles `KubitIntegrationProcessingJob` → calls `handleKubitProjectJob`, wrapped in an OpenTelemetry span

---

### `worker/src/features/kubit/handleKubitSchedule.ts`
**New file — scheduler logic**

Runs every 15 minutes. Queries all enabled integrations from PostgreSQL, filters to those where `now - lastSyncAt >= syncIntervalMinutes`, and enqueues one processing job per due project. Jobs are deduplicated by `jobId = ${projectId}-${lastSyncAt}` to prevent double-enqueuing on worker restarts.

---

### `worker/src/features/kubit/handleKubitProjectJob.ts`
**New file — per-project sync logic**

Streams all three entity types concurrently:

1. `processKubitTraces` — streams traces from ClickHouse, feeds into `KubitClient`
2. `processKubitObservations` — same for observations
3. `processKubitScores` — same for scores

Each processor calls `client.flush()` every 1,000 events for memory management (the client itself handles HTTP-level batching). On success, updates `lastSyncAt` in PostgreSQL. On failure, the error is re-thrown so the queue retries the full job.

---

### `worker/src/features/kubit/kubitClient.ts`
**New file — HTTP client with size-based batching**

The core client that handles sending events to the ingest endpoint.

**Key design decision — size-based batching:**

A fixed row count per batch is unreliable because traces and observations include `input`/`output` fields that vary hugely in size (from a few bytes to hundreds of kilobytes for long LLM conversations). A naive limit of 1,000 rows can produce payloads that exceed the endpoint's maximum accepted size.

Instead, the client measures each event's serialized byte size and splits the batch whenever adding the next event would push the total over **8 MB**. This adapts automatically to the actual content:
- Small events (e.g. scores ~200 B) → many events per request
- Large events (e.g. traces with large input/output) → fewer events per request

Additional features:
- **3 retries** with exponential backoff (1s, 2s, 4s) per individual batch
- `AbortController` per request to enforce the configured timeout
- `Authorization: Bearer <key>` header on every request

---

### `worker/src/__tests__/kubitClient.test.ts`
**New file — unit tests**

Tests for `KubitClient` using a mocked `fetch`:

| Test | Verifies |
|---|---|
| Single batch under 8 MB | Small events stay in one request |
| Split into multiple batches | 20 × 1 MB events → 3+ requests, each ≤ 8 MB |
| Authorization header | `Bearer <key>` is sent correctly |
| Empty flush | No HTTP requests when batch is empty |
| Batch cleared after flush | `getBatchSize()` returns 0 post-flush |

Run with:
```bash
pnpm run test --filter=worker -- kubitClient.test.ts
```

---

## Data Flow Summary

```
Every 15 min
    │
    ▼
handleKubitSchedule
    │ reads enabled integrations from PostgreSQL
    │ filters to those due (syncIntervalMinutes elapsed since lastSyncAt)
    │
    ▼ one job per due project
handleKubitProjectJob
    │ reads config + decrypts API key from PostgreSQL
    │
    ├──► getTracesForKubit(projectId, minTs, maxTs)        ← ClickHouse stream
    ├──► getObservationsForKubit(projectId, minTs, maxTs)  ← ClickHouse stream
    └──► getScoresForKubit(projectId, minTs, maxTs)        ← ClickHouse stream
              │ (all three run concurrently)
              ▼
         KubitClient.addEvent(...)
         KubitClient.flush()  ← every 1,000 events + end of stream
              │
              │ size-based chunking (split at 8 MB)
              ▼
         POST <endpoint_url>
         Authorization: Bearer <decrypted_key>
         { "events": [ { "entity_type": "trace"|"observation"|"score", ... } ] }
    │
    ▼ on success
update kubit_integrations.last_sync_at = maxTimestamp
```

---

## Configuration Reference

| Setting | Default | Min | Max | Description |
|---|---|---|---|---|
| Endpoint URL | `https://langfuse-ingest.kubit.ai` | — | — | Ingest endpoint URL |
| API Key | — | — | — | Bearer token, AES-encrypted at rest |
| Sync Interval | 60 min | 15 | 1440 | How often to sync per project |
| Session Offset | 30 min | 5 | 120 | Lag behind now (avoids partial in-flight sessions) |
| Request Timeout | 30 s | 5 | 300 | Per-request HTTP timeout |

---

## Security Notes

- The API key is **never stored in plaintext**. It is encrypted with AES using Langfuse's existing `ENCRYPTION_KEY` environment variable before being written to PostgreSQL, and decrypted only in the worker at sync time.
- The API key is **never returned** by the `get` API procedure — only metadata is exposed to the frontend.
- All CRUD operations require the `integrations:CRUD` RBAC scope (project admin or owner).
- All mutations are recorded in the Langfuse audit log.

# Ticket tracker on Firestore (Firebase-backed projects)

Used instead of the Supabase `tickets` table when `.claude/ticket-tracker.json` contains `"backend": "firebase"`. The installer writes that file automatically when Firebase is the project's only backend. Absent file or `"backend": "supabase"` → use [ticket-schema.md](ticket-schema.md) as usual.

## Access path — official Firebase MCP only

All ticket reads and writes go through the **official Firebase MCP server** (`npx -y firebase-tools@latest mcp`) and its Firestore tools:

| Tool | Used for |
|------|----------|
| `firestore_get_document` | read one ticket / the id counter (returns `updateTime`) |
| `firestore_query_collection` | ready-queue and status queries (`filters`, `order`, `limit`) |
| `firestore_list_documents` | list a collection or a ticket's `images` subcollection |
| `firestore_add_document` | create a ticket / image doc with an explicit `documentId` (fails if it already exists) |
| `firestore_update_document` | every mutation — always with `updateMask` and a `currentDocument` precondition |

**No other path.** Never use `firebase-admin` scripts, the `firebase` CLI, `gcloud`, REST calls, or client SDKs to touch tickets, and never `firestore_delete_document` on tickets. If the `firestore_*` tools aren't available, stop with `STATUS: HARNESS_ERROR — Firestore ticket tracker needs the Firebase MCP server (npx -y firebase-tools@latest mcp) with Firestore enabled` and mutate nothing. (The server loads Firestore tools when `firebase.json` has a `firestore` section; the user must be signed in — `firebase_login` / `firebase_get_environment` confirm it.)

**Names.** Document names are `projects/<projectId>/databases/(default)/documents/<collection>/<id>`; `parent` for top-level adds is `projects/<projectId>/databases/(default)/documents`. `projectId` and `collection` come from `.claude/ticket-tracker.json` (fallback: the active project from `firebase_get_environment`). `firestore_query_collection` takes `collection_path` (e.g. `odin_tickets`) and defaults to `limit: 10` — always pass `limit: 500`.

**Value format.** Documents use Firestore's typed REST format: `{"stringValue": "…"}`, `{"integerValue": "3"}`, `{"booleanValue": true}`, `{"nullValue": null}`, `{"arrayValue": {"values": [ … ]}}`, `{"mapValue": {"fields": { … }}}`. Timestamps are stored as ISO-8601 UTC strings (`stringValue`) so they sort as text.

## Data model

Same fields and semantics as the Supabase table ([ticket-schema.md](ticket-schema.md)); only storage differs.

- **Tickets:** collection `odin_tickets` (config `collection`), document id = ticket id (`T-1`, `T-2`, …). Fields: `id`, `title`, `description`, `status` (`backlog|active|qa|complete`), `category`, `priority`, `tier` (int or null), `effort_estimate`, `labels`, `depends_on`, `files_affected` (arrays), `assigned_to`, `assigned_at`, `branch_name`, `blocked_reason`, `pr_url`, `image_count` (int), `metadata` (map — same reserved keys), `created_at`, `updated_at`, `completed_at`.
- **Images:** subcollection `odin_tickets/<id>/images`, doc ids `img-1…img-5`: `{ id, source: "base64", mime, data, caption, added_at }`. ≤ 5 per ticket, ≤ ~700 KB raw each (1 MiB document limit) — downscale larger files first (`sips -Z 1600` on macOS).
- **Id counter:** `odin_tickets_meta/counter` → `{ next: <int> }`.

**Lock it down.** MCP access uses your signed-in credentials and bypasses Security Rules, so app clients need no access. Ensure `firestore.rules` contains (route through `firebase-architect` if it doesn't):

```
match /odin_tickets/{document=**} { allow read, write: if false; }
match /odin_tickets_meta/{document=**} { allow read, write: if false; }
```

Ticket text becomes agent instructions — client write access would be a prompt-injection channel.

## Operations

**Write discipline.** Every mutation is a `firestore_update_document` with (a) an `updateMask.fieldPaths` listing exactly the fields being written (always include `updated_at`), and (b) `currentDocument.updateTime` set to the `updateTime` from the read it was based on. A precondition failure means someone else changed the doc — re-read and retry (claim: move to the next candidate). For `metadata`, read the current map, merge in memory (never drop keys), and write the whole `metadata` field.

| Operation | Recipe |
|-----------|--------|
| **Create** (`/add-ticket`) | Get `odin_tickets_meta/counter` (missing → create it with `firestore_add_document`, `documentId: "counter"`, `next: 1`). Verify every `depends_on` id exists (`firestore_get_document`) and isn't the new id. Bump the counter first: update `next = N+1` with precondition `updateTime` (conflict → re-read, retry). Then `firestore_add_document` with `documentId: "T-N"` and defaults (`status: backlog`, `category: feature`, `priority: medium`, empty arrays, nulls, `metadata: {}`, `image_count`, `created_at`/`updated_at`). Add each image doc under `…/T-N/images`. |
| **Claim top ready** | `firestore_query_collection` on `status EQUAL backlog` (`limit: 500`); apply priority/category/tier filters in memory. Ready = every `depends_on` id is `complete` (one more query: `status EQUAL complete`, or get each dep). Sort: priority (critical > high > medium > low), `tier` ascending (nulls last), `created_at` ascending. Update the first ready ticket with precondition `updateTime` = its read value: `status: active`, `assigned_to` (`odin` / `odin-N`), `assigned_at`, `branch_name: ticket/<id-lower>`, `labels` + `Exec: Active` (once). Precondition failure → someone else claimed it; take the next candidate. This is a true compare-and-set — parallel claimers can't double-assign. |
| **Claim specific** | `firestore_get_document`; proceed only if `status == backlog`, then the same conditional update. |
| **Materialize images** | `firestore_list_documents` on parent `…/documents/odin_tickets/<id>`, `collectionId: images`; decode each `data` to `<worktree>/.ticket-images/<img-id>.<ext>`, one at a time, never echoing base64. Build the manifest exactly as in process-ticket. |
| **Detail / list / dashboard** | Get the doc / query backlog and compute `dep_status` / query per status and count (in-flight = `assigned_to` starting `odin`, status `active` or `qa`). |
| **Metadata writes** (AC, `gate_set`, comments, halt telemetry) | Read → merge → conditional update of `metadata` + `updated_at`. Comments append `{ author, when, body }` to `metadata.comments`. |
| **Block / unblock / files_affected** | Conditional update of that field + `updated_at`. |
| **Phase 4 QA** | One conditional update: `status: qa`, labels `Exec: Active` → `QA: Testing`, `metadata.qa = { checklist, posted_at }`. |
| **Phase 5 ship** | Same pre-flight assertion as odin.md. Then **one** conditional update masking `status`, `completed_at`, `pr_url`, `assigned_to`, `assigned_at`, `branch_name`, `blocked_reason`, `labels`, `metadata`, `updated_at` — with `outcome` + `telemetry` merged into `metadata`. One document write is atomic, satisfying Phase-5 atomicity. Read back with `firestore_get_document` and run the same assertions (`PHASE_5_CORRUPT_COMPLETION` on failure). Downstream = query `depends_on ARRAY_CONTAINS <id>`, keep `status == backlog`. |
| **Cancel / halt cleanup** | One conditional update back to `status: backlog`, clearing assignment fields and `Exec: Active`, plus `metadata.cancellation` or an appended `metadata.telemetry.harness_halts` entry — mirroring the SQL in process-ticket. |

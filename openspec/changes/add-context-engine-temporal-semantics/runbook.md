# Temporal Semantics Deployment Runbook

## Scope

This runbook covers the versioned conversation temporal backfill, backend rollout flags, the Agent timestamp gate, monitoring, and rollback. The migration is additive: new tables and columns remain in place during rollback.

## Pre-deployment Checks

1. Back up the SQLite database and retain its WAL/SHM files from the same checkpoint.
2. Confirm the backend typecheck and directed temporal tests pass.
3. Keep `CONVERSATION_INGESTION_INCLUDE_MESSAGE_TIMESTAMPS=false` on every Agent deployment.
4. For a shadow-first production rollout, explicitly set:

   ```bash
   CONTEXT_ENGINE_TEMPORAL_READ=false
   CONTEXT_ENGINE_EVIDENCE_LAYER=false
   CONTEXT_ENGINE_TEMPORAL_HARD_FILTER=false
   CONVERSATION_INGESTION_INCLUDE_MESSAGE_TIMESTAMPS=false
   ```

The backend library preserves the already-deployed temporal behavior when the first three variables are unset. Production shadow rollout must therefore set them explicitly to `false`.

## Deployment Order

1. Deploy the additive SQLite schema and repository code. Do not enable Agent timestamps.
2. Run the versioned backfill once:

   ```bash
   pnpm --filter @nexcore/backend backfill:temporal
   ```

3. Re-run the same command and confirm the completed migration record is returned unchanged.
4. Restart the backend and verify message evidence, Fact, STM/LTM temporal metadata, and indexes are restored.
5. Enable `CONTEXT_ENGINE_TEMPORAL_READ=true`. Keep the evidence layer and hard filter in shadow mode.
6. Enable `CONTEXT_ENGINE_EVIDENCE_LAYER=true` for a small tenant cohort.
7. Enable `CONTEXT_ENGINE_TEMPORAL_HARD_FILTER=true` after shadow differences are accepted.
8. Only after parser, persistence, Fact, STM/LTM, search, Context Pack, and session background checks pass, enable Agent timestamps for a small cohort:

   ```bash
   CONVERSATION_INGESTION_INCLUDE_MESSAGE_TIMESTAMPS=true
   IHUB_TIMEZONE=Asia/Shanghai
   IHUB_LOCALE=zh-CN
   ```

## Agent Gate

Agent timestamp output remains disabled until all of the following are true:

- backfill status is `completed` and repeated execution is idempotent;
- no cross-Session message leakage or quote/source validation regression is present;
- shadow result differences are reviewed for representative temporal queries;
- `TEMPORAL_BACKFILL_FAILED` rate is zero or every failed ingestion has an owned retry plan;
- evidence and valid-time acceptance queries return concrete message citations;
- rollback flags have been exercised in the target environment.

## Monitoring

Track these values by deployment cohort and migration version:

- backfill `scanned`, `updated`, `skipped`, `failed`, `retried`, and duration;
- restored message, Fact, STM, LTM, and index counts;
- `TEMPORAL_PROTOCOL_INVALID`, `TEMPORAL_SOURCE_NOT_FOUND`, `TEMPORAL_QUOTE_MISMATCH`, `TEMPORAL_RANGE_INVALID`, `TEMPORAL_METADATA_MISSING`, and `TEMPORAL_BACKFILL_FAILED` counts;
- search `filterBeforeCount`, `filterAfterCount`, drop-reason counts, and shadow added/removed result counts;
- resolver source/confidence and semantic resolver fallback rate;
- extended versus legacy Session rate and low-confidence evidence rate;
- p95 search latency while shadow comparison is active.

Traces contain IDs and counts only. Do not log raw conversation messages or unauthorized evidence content.

## Rollback

1. Set `CONVERSATION_INGESTION_INCLUDE_MESSAGE_TIMESTAMPS=false` and restart Agents.
2. Set `CONTEXT_ENGINE_TEMPORAL_HARD_FILTER=false` to restore legacy result inclusion while retaining shadow comparison.
3. If necessary, set `CONTEXT_ENGINE_EVIDENCE_LAYER=false` and `CONTEXT_ENGINE_TEMPORAL_READ=false`.
4. Restart the backend and verify the trace reports the disabled flags and shadow differences.
5. Do not drop `context_engine_migrations`, conversation evidence tables, temporal columns, structured facts, or indexes. They are retained for audit and a forward retry.
6. Restore the database backup only for verified data corruption, not for a normal feature rollback.

## Failure Recovery

When a migration record is `failed`, fix the source or code issue and rerun the same version. Successfully restored rows are upserted idempotently; the attempt and retry counts increase, and individual errors contain ingestion/session/document IDs without message bodies.

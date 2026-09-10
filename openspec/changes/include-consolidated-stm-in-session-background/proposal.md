# Change: Include consolidated STM in session background

## Why

Conversation ingestion immediately runs LTM consolidation after STM admission. Once Dreaming creates an LTM, the source STM is marked `consolidated`, but the background selector currently accepts only `active` STM. A new Agent session can therefore observe pending STM in its time window while sending none of them to the background LLM.

## What Changes

- Treat every generated, non-deleted STM as recallable and eligible for fixed and dynamic background analysis, regardless of admission lifecycle or the legacy `hidden` access state.
- Keep existing owner, time-window, permission-invalid, provenance, candidate-limit, and token-budget filters.
- Normalize new and existing generated STM away from the legacy `hidden` state and backfill missing recall indexes.
- Preserve the rule that LTM is not separately added to background analysis, avoiding duplicate STM/LTM evidence.
- Add search, selector, session-background, and startup-index regression coverage for generated STM.

## Impact

- Affected capability: `context-engine`
- Affected modules: background STM selector, session background generation, background documentation and tests
- No storage migration or API shape change is required.

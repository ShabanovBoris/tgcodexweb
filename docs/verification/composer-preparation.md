# Composer preparation and stale draft — 2026-10-21

Task: investigate two Telegram `PROVIDER_UNAVAILABLE` failures following successful
delivery of the earlier generated image, and restore preparation of new requests.

## Observed failure

Both requests are durably `failed / SEND_FAILED_PRE_SUBMIT`, without `submitted_at` or
provider request IDs. Telegram delivered their errors. Native browser inspection of
only the mapped conversation found one editable composer containing a **40-character**
draft, exactly matching the operator's failed request, and one enabled Send button.
No request was sent from that diagnostic window. Authentication remained valid.

The leftover draft explains the next attempt's busy-composer rejection. The exact
low-level trigger of the first failure was not retained by the normalized diagnostics.
The old implementation immediately rejected a temporarily disabled Send control and
closed a failed preparation page without removing its input. Both weaknesses were
reproduced in deterministic tests before the correction.

The first authorized full-flow check after that correction also failed before Send.
Its owned draft was successfully removed. Native inspection identified the newer
markdown composer: inserting text into its fully initialized editor enabled Send,
whereas the initially rendered page exposed an editable field with disabled controls.
An isolated hydration fixture reproduced loss of input inserted before the handler
mounted. Waiting only after insertion was therefore insufficient. This supports the
preparation correction below; it does not recover the original failure's missing trace.

## Correction and invariants

- An empty markdown composer first waits up to 20 seconds for its disabled submit
  placeholder to disappear, before any insertion. This readiness check stays inside
  the gateway worker adapter and does not change legacy editor preparation.
- Preparation then waits within the existing 20-second action bound for exact readback and
  one enabled Send control, without inserting text again. Ambiguous multiple controls
  still fail. The history baseline, generation state and exact prompt are checked after
  waiting and before activation.
- A pre-activation failure can clear only the unchanged plain draft this operation
  inserted into an initially empty editor. The worker reuses its existing native editor
  cleanup. Non-editable pills, pre-existing/changed text and uploaded-file requests are
  preserved. This cleanup is bounded and joined before page disposal.
- Once Send activation may have occurred, cleanup and replay remain forbidden. The
  owned ambiguous page and UNKNOWN behavior are unchanged. Core request states, dedup,
  canonical serialization, provider ports, authentication and migrations are unchanged.
- The old failed requests stay terminal. No automatic retry was introduced. New live
  prompts below came from separate real Telegram updates under the operator's explicit
  full-flow verification request. The earlier media connection correction is retained.

## Executed checks

- Before implementation, `gateway-preparation.test.ts` reproduced delayed-readiness
  rejection and retained owned input: **3 failures**, **3 passes**.
- Focused preparation/session/health/provider tests after implementation: **31 PASS**,
  **119 assertions**, **0 failures**.
- Before the hydration correction, its isolated browser case failed with
  `not_submitted / PROVIDER_UNAVAILABLE` rather than the expected submitted receipt.
  After correction it submits the exact prompt once.
- Full `bun --no-env-file run verify`: **PASS**, **577 tests**, **3637 assertions**,
  **23 opt-in cases skipped**, **0 failures**. Toolchain/typecheck/lint/format passed;
  the six existing lint warnings remain unchanged.
- Final explicit isolated Chromium suite without instrumentation: **22 PASS**,
  **142 assertions**, **0 failures**, **61.16 seconds**. All URLs are intercepted and
  profiles are temporary. Three new cases cover delayed Send, pre-insertion hydration
  and cleanup of persisted input across reopen followed by one different submission.
  The prior nineteen text/upload/correlation/image cases also pass.
- Two earlier combined runs timed out in the existing inaccessible-conversation case.
  It passed alone, then all 22 passed with synthetic navigation tracing, and finally
  all 22 passed without tracing. The traces showed the expected authenticated 404
  becoming `chat_not_found`. No assertion or timeout was weakened. The earlier timing
  failures remain recorded; the final pass does not establish their exact cause.
- Existing provenance checks pass with updated final hashes for `browser-worker.ts`
  and `gateway-session.ts`. Original upstream revision/blob IDs and dependency pins
  remain fixed.

Private logs and operational metadata are under ignored
`data/operations/composer-preparation-20261021/`. They contain no prompt, image bytes,
token, cookies or signed asset links. No Git branch/index/commit/push operation was used.

## Live restoration and full-flow verification

After the operator unlocked the Mac, native browser controls cleared the known stale
draft in the mapped conversation. Reload confirmed that the editor remained empty.
No Send was pressed during maintenance or the later insertion comparison; all diagnostic
drafts were cleared. No alternative automation bypassed the locked-screen restriction.

The live check used normal `startGateway` composition, the existing configuration,
database, profile, queue and Telegram poller. An ignored operational runner observed
SQLite state and media receipts through the existing optional Telegram API injection;
it created no synthetic updates and did not drive provider submission. One new real
Telegram update failed before Send at 18:06 UTC and remained terminal. After the hydration
correction, another new update completed this sequence on 2026-10-21 (all times UTC):

| Evidence | Time / result |
| --- | --- |
| Real Telegram update durably accepted | 18:16:05.556 |
| ChatGPT submission confirmed | 18:16:09.134 |
| While waiting | Exact new user turn, intermediate image preview, responding state and Stop observed natively; no early result sent |
| Provider completion persisted | 18:18:04.936, about 115.8 seconds after submission |
| Telegram preview accepted | 18:18:06.834, HTTP 200, one confirmed call |
| Telegram original document accepted | 18:18:08.161, HTTP 200, one confirmed call |
| Original downloaded back and checked | 18:18:13.308, exact byte count and SHA-256 match |

The output was PNG, **1448 × 1086**, **2,417,739 bytes**. Original SHA-256:
`8dd7078fadcbe7c64f5b46094c6cd0158097741e90c2db2f4125760addf42bf0`.
Both multipart calls used fresh connections. Native Telegram inspection showed the
completed preview and `original-1.png` with the caption «Скачать оригинал». The durable
delivery completed in one attempt at cursor 2, with payload and plan purged afterward.

All eight pre-existing table snapshots match after excluding the two new verification
requests and their dependent rows. Integrity is `ok`, foreign-key violations are zero,
and no active or pending requests remain. Old failures and UNKNOWN records were not
replayed or rewritten. The diagnostic runtime was stopped while idle and replaced by
the ordinary manual CLI gateway. It is the sole lease/database owner. LaunchAgent is
disabled and unloaded, as requested.

This proves one new live image-generation round trip and original-file integrity on
the current account/network. It does not establish VPN-outage behavior or guarantee
compatibility with future ChatGPT UI changes.

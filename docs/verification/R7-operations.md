# R7 — Doctor, scoped status and durable final-result delivery

Date: 2026-10-20 (Europe/Moscow). PR #10 was approved for `ceca61c…` and merged as
`9b88f9329960406171887dc34e8e3fcef5426444`. This report concerns the subsequent local
operational changes; that earlier review does not constitute review of this delta.

## Approved policy and scope

The operator explicitly chose retrying ambiguous Telegram delivery, accepting duplicate
parts, and retaining saved output until delivery or 24-hour expiry. Provider prompts still
must not repeat. The implementation adds no remote control API, Web UI, prompt scheduler,
account support or provider/native data outside the established adapter boundary.

`doctor` prints a structured preflight report; `/doctor` uses the owned runtime. It checks
configuration before effects, existing DB integrity/immutable migration history without
applying SQL, Telegram only through `getMe`, and provider health under the process lease.
A missing DB/profile is not initialized. The lease remains held through provider disposal;
a busy gateway skips the competing browser probe. `readyToStart` is not daemon READY.

Two read-only recovery regressions were reproduced before correction: failed initial
navigation left a live unusable probe, and simultaneous health calls created two pages.
The session now discards failed probes, coalesces concurrent checks, permits safe later
reopening after context close and joins health during disposal. Mutation-page ownership,
attempted identities and UNKNOWN remain intact. The fork addition manifest is updated to
`39fd1f06dce1f19a0755ca02ad01a940fb77b8e14de74fe6d0bb900c64ba0101`.

Initial `getMe` now has its own five-retry read-only budget and 60-second server-minimum
limit before DB/provider initialization. Its hint is distinct from polling and delivery.
Known network/own-timeout/5xx/flood evidence can retry; invalid token, TLS/unclassified
errors and malformed success remain fatal. Identity HTTP/backoff cancellation propagates.
Recovery initializes once and never repeats application effects or an accepted prompt.

Telegram status distinguishes component readiness, blocked/queued/active work and durable
delivery errors. Only the caller's historical request IDs are shown. UNKNOWN instructions
require inspection of the exact completed remote response and stopping the bot before
offline confirmation. Database read failure becomes explicit ERROR; missing authentication
remains distinguishable during a transport outage. No diagnosis releases a block.

## Atomic output and bounded delivery

Forward migration 0007 adds an initially empty `request_deliveries` table. A composite
repository transaction commits terminal settlement, input cleanup and operational output
together; a rejected insert rolls all of them back. Separate application settlement and
transport delivery ports keep rendering/cursor operations out of request execution and
prevent delivery from settling or enqueueing provider work.

The transport persists its render plan before the first HTTP send and checkpoints each
confirmed part. A crash after remote acceptance but before the local checkpoint may repeat
that part. Previously confirmed parts are skipped. A persisted final checkpoint finalizes
delivery without another send, including after an exhausted budget or expiry. All output
and render-plan content are removed on success; request lifecycle and dedup remain intact.

The budget is six attempts, including crashed attempts, with retry waits 1/2/4/8/16 seconds.
An allowlisted delivery hint preserves valid flood-control minima up to 60 seconds;
missing/invalid/unsupported minima and permanent errors fail without retrying early.
Polling hints remain separate. Native send errors or lost receipts can authorize another
delivery under the approved ambiguity policy. Rich-parser fallback still affects only the
rejected part. The worker rechecks historical destination/allowlist before each part and
shares one owned attempt with initial delivery. Plain fallback rechecks expiry, destination
authorization and cancellation after the rich-parser rejection. HTTP cancellation propagates, and runtime
shutdown joins active work before DB/provider disposal and lease release.

The runtime expires pending/failed output at startup and on its owned sweep. Nothing can
be sent at or after its 24-hour deadline. A stopped process cannot delete bytes until next
startup; SQLite WAL/backups have the same row-deletion limitations as R2 input. Expiry keeps
only metadata with `TELEGRAM_DELIVERY_EXPIRED`, visible in status. Older completed rows
without output cannot be reconstructed. No live database/profile has been migrated here.

## Evidence

| Acceptance / invariant | Offline evidence |
| --- | --- |
| AC-J01..J04, I2/I7 | `doctor`, `telegram-diagnostics`, `cli/doctor`: normalized readiness, invalid config/token, lease contention/disposal, missing resources without initialization, auth during outage, explicit storage ERROR, no provider mutations |
| AC-D04/D05, AC-F05, I4/I6 | `request-results`: atomic output/settlement/input cleanup, rollback on rejected output, stable render plan/cursor, stale cursor rejection, persisted budget, final acknowledgement recovery, 24-hour purge |
| AC-D05, AC-F05 | `delivery-recovery`: actual SIGKILL after provider completion before delivery and after synthetic Telegram acceptance before acknowledgement; reopen sends only stored output and performs zero provider sends/inspections |
| AC-B02, AC-D05 | `telegram-durable-results`: concurrent callback/worker coalescing, progress ordering, original reply target, changed selection, revoked allowlist after reopen, scoped errors and expiry visibility |
| Retry/resource ownership | `telegram-delivery-api`, `telegram-result-delivery`, `delivery-runtime`: network/lost receipt, bounded waits/budget, flood minima, fallback with renewed TTL/authorization/abort checks, caller abort, one runtime provider prompt, lease retained until owned HTTP settles |
| Read-only recovery | `gateway-health-recovery`: failed-navigation discard, concurrent coalescing, context reopen, auth state and close joining; `telegram-identity-recovery`/runtime: pre-init retry budget/minima, fatal errors, abort and initialization exactly once |
| Persistence | fresh 0007 constraints, populated 0006 upgrade, failed-upgrade rollback, reopen, FK checks; all older migration/retention/recovery suites retained with counts advanced for 0007 |
| AC-K01..K04 | central logger/redaction tests, operational trace from Telegram update through provider send/submission/settlement to delivery, metadata-only diagnostics, DB schema assertions; prompts/answers/native errors and credentials excluded from logs |

Author verification on pinned Bun 1.4.0: full `bun --no-env-file run verify` passed toolchain,
TypeScript, Biome lint/format and **539 tests / 3389 assertions, 0 fail**. Normal verification
skipped 12 opt-in cases (551 cases across 45 files). The separate approved, offline
Chromium/synthetic-site profile passed **12 tests / 81 assertions**, including the complete
Telegram ingress/queue/fork/durable-completion/response path. Every URL is intercepted.
The final ingress case was also rerun after the plain-fallback guard correction; it passed
with **1 test / 9 assertions** on the resulting sources. The focused delivery/restart/shutdown
suite passed **25 tests / 129 assertions**. Previously applied migrations 0001–0006 are
byte-identical to the base; the fork manifest matches the resulting addition.

Initial development checks exposed missing doctor/UNKNOWN guidance and old migration-count
expectations; these were corrected without weakening migration data/schema assertions.
The final audit reproduced three late-fallback failures (expiry, revoked destination and
cancellation after parser rejection); all were fixed by checking the send prerequisites
again before plain fallback.
The earlier failed-Enter policy remains conservative; the fork delta changes only the
read-only health lifecycle and joins its disposal.

## Limits and remaining R7 work

All added tests use synthetic API/provider boundaries, temporary databases and isolated
subprocesses. No new live Telegram/ChatGPT prompts, operator profile access, runtime restart
or production migration were performed. This is author evidence; at this verification stage
the delta had not yet received an independent review or been published as a new PR.

Automatic observation correlation/resumption of ambiguous work remains deferred. Existing
conservative startup reconciliation and no-replay behavior remain in force. The new code
still needs independent review and release/acceptance checks. Full R6/R7/R8/MVP acceptance
is not declared complete.

The retry minimum follows the primary
[Telegram ResponseParameters contract](https://core.telegram.org/bots/api#responseparameters);
successful `sendMessage` returns a
[Message receipt](https://core.telegram.org/bots/api#sendmessage). The approved ambiguous
delivery behavior is a product decision, not a claim of an exactly-once Bot API guarantee.

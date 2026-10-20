# R7 — Explicit operator recovery of completed UNKNOWN

## Incident and approved behavior

On 2026-10-20 the operator reported that Telegram returned `SUBMISSION_STATE_UNKNOWN`
while ChatGPT was still processing a photo. Read-only SQLite inspection found one UNKNOWN
without saved submission correlation and two independently queued requests. Read-only
inspection of the exact ChatGPT chat confirmed the photo's completed response after the
three previously completed requests. No prompt was sent during diagnosis.

The operator approved manual recovery and preservation of both queued requests. The
20-second send-acknowledgement limit is a possible explanation; the precise failure branch
was not recorded and is not established by the later, completed page. This change does not
claim to fix that underlying acknowledgement failure.

## Implementation and boundaries

- `recover:unknown <request-id> --confirm-completed` accepts a validated request UUID and
  an explicit assertion that the exact remote response has completed. It uses only local
  database configuration and never opens a provider/browser/Telegram connection.
- Forward migration 0006 adds a separate, idempotent operator confirmation. Original UNKNOWN,
  timestamps, correlation, ingress markers and queued payloads remain unchanged. Queue
  reconstruction/claim release only the confirmed request's exact canonical key.
- Runtime and maintenance share an exclusive SQLite lease in an adjacent file, held through
  provider disposal. A competing runtime/maintenance call fails closed. SIGKILL releases
  the OS lock; no stale-PID heuristic or lock-file deletion is used.
- This is an operator assertion, not recovered provider evidence or an UNKNOWN-to-COMPLETED
  transition. It does not resend the original request or deliver its previous response.

## Verification

Automated evidence covers AC-E01/E02/E03/E05, AC-F02/F03/F05/F06 and invariants I4/I5/I6:
fresh schema constraints, populated 0005 upgrade/rollback/reopen, rejected/failed audit writes,
unchanged UNKNOWN/dedup/input, exact-key blocking, queued FIFO exactly once across restart,
explicit CLI confirmation, credential-free operation, runtime exclusion through provider
disposal and actual cross-process lease release on SIGKILL.

On Bun 1.4.0, the full `bun --no-env-file run verify` passed: toolchain, TypeScript,
Biome lint/format, **429 tests / 2857 assertions, 0 fail**. The 12 opt-in browser cases
were skipped (441 cases across 32 files). No upstream browser code changed; no live prompt
was sent by verification.

## Local recovery receipt

After verifying there was no Bun/Chromium bot process, a consistent SQLite backup was
created under ignored `data/backups/` with mode 0600; its integrity check returned `ok`.
At `2026-10-20T12:25:17.737Z`, the offline command recorded one
`operator_confirmed_completed` resolution for the incident request (`b215361d…`).
Read-only verification found no queue blockers and the two original queued successors in
their original order. Before/after hashes matched for all rows in `requests` (19),
`request_inputs` (2), `request_acceptances` (19), `attachments` (2), `processed_updates` (58)
and `conversations` (4). Migration version is 6; integrity is `ok`, with zero FK violations.
Both retained attachment files were readable, regular files with their declared sizes.
The bot was not started and queued requests were not dispatched during this maintenance.

## Limits

The original submission acknowledgement failure was not established by this receipt;
the subsequent [Send action review correction](R7-send-acknowledgement.md) preserves UNKNOWN
on ambiguous Enter errors, rejects foreign-turn correlation and adds diagnostic reasons.
Full UNKNOWN UX, automatic observation recovery, durable delivery retry, doctor and remaining R7/R8 acceptance
are outside this slice. The lease coordinates this version's entry points; older bot versions
must be stopped before maintenance. Operator confirmation requires actual inspection of
the exact remote response; a timeout or missing Stop button alone is insufficient.

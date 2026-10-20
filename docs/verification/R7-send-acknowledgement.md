# R7 — Preserve UNKNOWN after an ambiguous Send action error

## Incident and review finding

After operator recovery, the first preserved request completed and was delivered. The
second (`b9ee1326…`) became UNKNOWN after 23.241 seconds without persisted submission
correlation. The operator screenshot and read-only inspection of the owned Chrome window
confirmed its completed response in the exact ChatGPT chat. A subsequent Telegram request
remained queued. Older responses in that window displayed a load error; that observation
alone does not establish why submission acknowledgement was lost.

The pinned upstream `sendAttachedPrompt` documents that a Locator timeout can occur after
Enter has submitted. The initial PR head `161462615886e1fe4ccd5cba82f630a389cc66eb` continued
receipt observation after that error. Its review returned CHANGES_REQUIRED: an error can
also precede dispatch, and one foreign user turn in the same remote conversation could
then be mistaken for our submission. A new regression with only that foreign turn failed
against the initial head: the adapter returned `submitted` with the foreign turn ID.

## Correction and invariants

Any Enter action error now returns UNKNOWN with `send_activation_unconfirmed` immediately.
No remote user turn is bound and its assistant response cannot complete our request.
This deliberately retains ambiguity even if our own input actually reached ChatGPT;
the adapter has no input-level evidence that distinguishes it from an external sender.
The bounded receipt check after a successful Enter is unchanged. There is no second Enter,
automatic UNKNOWN release, guessed provider correlation or replay. Explicit operator
confirmation remains the way to release a verified completed UNKNOWN queue block.

The unused `activationRecovered` receipt metadata and recovered-submission diagnostic
were removed. UNKNOWN diagnostics retain allowlisted reasons for activation without
confirmation, acknowledgement timeout, competing user turns and observation failure.
Raw exceptions, page URLs, prompts and answers never enter these diagnostics. An optional
log sink failure cannot alter the outcome. Fork addition hashes are updated;
application/domain contracts and durable recovery behavior remain unchanged.

## Verification

The new regression first reproduced the sole-foreign-turn failure on the initial PR head.
After correction, focused gateway/provider/fork tests passed: **21 tests / 119 assertions**.
They cover an Enter error before dispatch with one foreign user/assistant pair, no binding
or response observation, duplicate suppression, errors despite apparent receipt evidence,
successful Enter acknowledgement and its UNKNOWN branches, normalized diagnostics and
a failing diagnostic sink. The fork provenance test verifies the updated addition hash.

Full `bun --no-env-file run verify` on pinned Bun 1.4.0 passed: toolchain, TypeScript,
Biome lint/format and **441 tests / 2901 assertions, 0 fail**. The normal run skipped
12 opt-in browser cases (453 cases across 33 files). The separate real-Chromium suite
passed **12 tests / 81 assertions**, using the approved execution outside the sandbox.
Normal tests remain offline; browser fixtures intercept every URL and do not prove live
ChatGPT selectors or the exact cause of the earlier incidents.

## Prior authorized live queue check

The following evidence predates this review correction and belongs to the initial PR head.
The operator explicitly approved restoring the completed `b9ee1326…`, restarting the bot
and executing the already queued test message, with no repeated photo. Preflight found no
remaining bot process and no active request. A consistent mode-0600 SQLite backup was saved
under ignored `data/backups/` before maintenance. At `2026-10-20T13:32:09.564Z` the offline
command recorded the second operator resolution. Hashes for all original request, input,
attachment, acceptance, mapping and dedup rows were unchanged; the sole queued request was
still `ff4cb309…`.

The restricted start returned `TELEGRAM_UNAVAILABLE` before application initialization;
the approved network-capable start succeeded. The pending test had confirmed submission
at `13:33:01.009Z`, durable completion at `13:33:13.151Z`, and `telegram.delivered` with
`requestState=completed` at `13:33:13.268Z`. No new synthetic prompt or repeated photo was
sent. The database contained zero operational inputs after completion, both historical
UNKNOWN rows retained their operator resolutions, and integrity was `ok`.

That request used ordinary acknowledgement. The running bot has not been restarted with
this review correction, and no new live prompt was sent for the correction. The earlier
processes emitted no reason diagnostics, so their precise failure branch remains unproven.
Any additional live acceptance check requires explicit operator opt-in.

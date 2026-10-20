# R7 — Observe acknowledgement after a Send action error

## Evidence and scope

After operator recovery, the first preserved request completed and was delivered. The
second (`b9ee1326…`) became UNKNOWN after 23.241 seconds without persisted submission
correlation. The operator screenshot and read-only inspection of the owned Chrome window
confirmed its completed response in the exact ChatGPT chat. A subsequent Telegram request
remained queued. Older responses in that window displayed a load error; that observation
alone does not establish why submission acknowledgement was lost.

The pinned upstream `sendAttachedPrompt` explicitly documents that a Locator timeout can
occur after Enter has submitted. The gateway instead returned UNKNOWN immediately after
any activation error. A deterministic regression reproduces that defect: physical Enter
throws while the same page/baseline exposes exactly one new logical user turn at the expected
remote URL. Before this correction, no receipt read occurred and the test failed.

## Change and invariants

After the one activation settles, its error no longer skips the existing read-only
acknowledgement loop. The same 20-second acknowledgement budget and exact identity/URL
requirements apply. Valid evidence reports submitted and normal observation continues;
missing, competing or unreadable evidence remains UNKNOWN. There is no repeated Enter,
automatic UNKNOWN release, guessed provider correlation or replay. The action's own
20-second bound remains in place; a failed action can now be followed by the bounded
acknowledgement observation.

The adapter logs allowlisted reason codes for activation without confirmation,
acknowledgement timeout, competing user turns and observation failure, plus confirmed
submission after an action error. Raw exceptions, page URLs, prompts and answers never
enter these diagnostics. An optional log sink failure cannot alter a submission outcome.
Fork addition hashes are updated; application/domain contracts remain unchanged.

## Verification and limits

Focused regression/provider/fork tests passed: 17 tests / 102 assertions. They cover exact
receipt after an action error, no receipt/foreign/unreadable evidence, one activation,
port normalization, allowlisted diagnostics and a failing log sink.

Full verification on Bun 1.4.0 passed: toolchain, TypeScript, Biome lint/format and
**437 tests / 2884 assertions, 0 fail**; 12 opt-in browser cases were skipped by that normal
run (449 cases across 33 files). The separate real-Chromium/synthetic-site profile passed
**12 tests / 81 assertions**. Its initial restricted run returned provider unavailable;
the same offline command passed when run with approved execution outside the sandbox.

## Authorized live queue check

The operator explicitly approved restoring the completed `b9ee1326…`, restarting the bot
and executing the already queued test message, with no repeated photo. Preflight found no
remaining bot process and no active request. A consistent mode-0600 SQLite backup was saved
under ignored `data/backups/` before maintenance. At `2026-10-20T13:32:09.564Z` the offline
command recorded the second operator resolution. Hashes for all original request, input,
attachment, acceptance, mapping and dedup rows were unchanged; the sole queued request was
still `ff4cb309…`.

The restricted start returned `TELEGRAM_UNAVAILABLE` before application initialization;
the approved network-capable start succeeded. The pending test then had confirmed
submission at `13:33:01.009Z`, durable completion at `13:33:13.151Z`, and
`telegram.delivered` with `requestState=completed` at `13:33:13.268Z`. No new synthetic
prompt or repeated photo was sent. The database contained zero operational inputs after
completion, both historical UNKNOWN rows retained their operator resolutions, and integrity
was `ok`. The updated bot remains running. This live text request used ordinary
acknowledgement; the post-action-error branch is established by the deterministic regression.

These tests establish the code defect and correction, not the exact branch taken by the
two earlier live UNKNOWN requests. Those processes did not emit reason diagnostics.
Any live acceptance check requires explicit operator opt-in.

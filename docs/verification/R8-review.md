# R8 — Independent review record

**Verdict: APPROVE**, received 2026-10-21 (Europe/Moscow) in the existing
[Доступ ChatGPT через Telegram](https://chatgpt.com/c/6abce299-fdbc-83ed-9b04-7016343a6984)
ChatGPT conversation. The full package was sent after the operator explicitly
authorized its contents and destination. The native thread connector was
unavailable, so the same Markdown packet was attached through the browser.

This is the review of **R8**, separate from the earlier PR #11 approval.

## Exact reviewed version

- Base HEAD: `8fd58ec0498055e6f883fcc3859c9d7d9eb57dcf`.
- Base tree: `c895bb9386825f1e7af2ff6f0674589c3ae693ca`.
- Snapshot manifest SHA-256:
  `47cdd44256a9918c76801086f75ad9750aa9f7722ec0da439cf03854217e297f`.
- Full patch SHA-256:
  `ee7ce4ca31810f1a4864e87fa835a0727f5d9b2e13b89155178a6bc9c066b337`.

The manifest is SHA-256 of sorted `SHA256`, two ASCII spaces, relative path and
newline records for the following six files:

| File | SHA-256 |
| --- | --- |
| README.md | `44a890dd05437e91236e7298cdc9c4d25d1f05867cae8fb2461560311a088988` |
| ROADMAP.md | `4cc39ba533f33a9ec18e8fa4cc8c32112c65b35371f2a35d005d8e73da3eaa31` |
| docs/verification/R8-acceptance.md | `57492491ce1490256f78950827053f0e1250bb86cfba52e9bf77fdeac5e1c35d` |
| docs/verification/R8-evidence.json | `248659f10725f65582ddf404d024941f9bae17ecf77989a144d8b3c3456ddce2` |
| tests/fixtures/provider-crash.ts | `e271a648ab2061d439b8b56eef000e2dcfc54838b3f3cd0e37352b0fefd11fec` |
| tests/persistence/request-recovery.test.ts | `7624bc2055dfbfc0bd0e186049036cc054d5ab5f6e145259d5cdd1a902eca327` |

The reviewer independently reconstructed all six resulting files from the
complete 1,994-line attachment, verified every file hash, patch hash and manifest,
and checked that the PR #11 merge commit `4d4b897c77103907d1564f919e3562f4c589a12e`
has the same tree as the selected base. No extraction gap remained.

## Scope of the independent verdict

The reviewer checked the exact base ACCEPTANCE/source through GitHub,
JSON/matrix/witness consistency, all 57 matrix rows, the 55 PASS results and the
two capability conditions. AC-E04 and AC-H01 are correctly N/A for the real
single-conversation/non-cancelling adapter; their fake-provider contracts pass.

The new uploading and pre-submit SIGKILL cases were accepted as conservative
crash-safety evidence: restart uses UNKNOWN without treating the fixture's extra
knowledge as durable `not_submitted` proof, never replays the original request,
preserves its queued successor/dedup, and cleans terminal input/attachments.

No blocking findings were reported. One non-blocking terminology note was
explicitly accepted: zero Send calls in the pre-submit receipt means
`FakeChatProvider.sendCalls === 0`. RequestService has entered the overriding
`CrashProvider.send()` method, which pauses before `super.send()` and any fake
submission. The acceptance report already identifies that exact boundary. The
reviewed files were preserved after the verdict.

The reviewer accepted the stated fresh-install/security/live-evidence limits,
including the historical R6 checker exit 1. A separate scan of the attached
package found zero recognizable token/JWT/private-key strings.

Independent work was read-only source/attachment analysis, reconstruction,
hashing and consistency checks. The reviewer did **not** run Bun, Chromium, the
fresh installation, production DB inspection or live Telegram/ChatGPT scenarios.
The 541 offline tests / 3,415 assertions and 12 synthetic browser tests / 81
assertions remain author execution evidence.

Final response explicitly states:

> Final verdict: APPROVE — 47cdd44256a9918c76801086f75ad9750aa9f7722ec0da439cf03854217e297f / ee7ce4ca31810f1a4864e87fa835a0727f5d9b2e13b89155178a6bc9c066b337.

This record was intentionally excluded from that snapshot and added only to
record the verdict. Changes to the six reviewed files require a new snapshot and
review. Private raw logs, manifests and the exact submitted packet are retained
under ignored `data/operations/r8-acceptance-2026-10-21-3f736332/`, with a hash
index and private file permissions; runtime credentials/profile/DB are excluded.

Acceptance is complete for the documented applicable criteria. No publication,
commit, branch change, PR, merge or MVP tag was performed in R8. Those release
actions still require the operator's separate authorization.

## Final runtime observation

After the verdict, the final local check found that the earlier working process
PID 86766 had exited: signal-0 reported no such process, and neither the gateway
lease nor the database had an open holder. The previous chat's PTY was unavailable
here, so the exit cause is **not established**; it is not attributed to polling
retry exhaustion without a log. Earlier in R8 the same PID still held the lease.

The final read-only DB check still returned integrity `ok`, FK errors 0 and no
retained input/attachment/output content. This operational observation does not
change the reviewed code or acceptance evidence. Restart with the existing
configuration/database/profile was requested as a separate operator choice;
no restart or new live prompt was performed without that authorization.

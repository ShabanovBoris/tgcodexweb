# R8 — independent review

Review date: **2026-10-21**.

## Reviewed snapshot

- Base HEAD: `8fd58ec0498055e6f883fcc3859c9d7d9eb57dcf`
- Base tree: `c895bb9386825f1e7af2ff6f0674589c3ae693ca`
- Snapshot manifest SHA-256: `47cdd44256a9918c76801086f75ad9750aa9f7722ec0da439cf03854217e297f`
- Patch SHA-256: `ee7ce4ca31810f1a4864e87fa835a0727f5d9b2e13b89155178a6bc9c066b337`

The reviewed snapshot consists of exactly these six files:

- `README.md` — `44a890dd05437e91236e7298cdc9c4d25d1f05867cae8fb2461560311a088988`
- `ROADMAP.md` — `4cc39ba533f33a9ec18e8fa4cc8c32112c65b35371f2a35d005d8e73da3eaa31`
- `tests/fixtures/provider-crash.ts` — `e271a648ab2061d439b8b56eef000e2dcfc54838b3f3cd0e37352b0fefd11fec`
- `tests/persistence/request-recovery.test.ts` — `7624bc2055dfbfc0bd0e186049036cc054d5ab5f6e145259d5cdd1a902eca327`
- `docs/verification/R8-acceptance.md` — `57492491ce1490256f78950827053f0e1250bb86cfba52e9bf77fdeac5e1c35d`
- `docs/verification/R8-evidence.json` — `248659f10725f65582ddf404d024941f9bae17ecf77989a144d8b3c3456ddce2`

This review file is a post-review protocol and is intentionally **not** part of the snapshot manifest above.

## Verdict

**APPROVE**

The independent review found no blocking acceptance or evidence defect for the exact snapshot above.

The review independently checked:

- completeness of the 53 acceptance criteria plus G1–G4;
- applicability of conditional AC-E04 and AC-H01 to the real provider capabilities;
- the new uploading/pre-submit SIGKILL crash witnesses and their no-replay semantics;
- separation of automated evidence from historical bounded live evidence;
- scope and limitations of fresh-install, security and secret-audit claims;
- exact reconstruction of the six reviewed files and their SHA-256 values;
- exact patch SHA-256 and reviewed base tree identity.

The reviewer did **not** rerun Bun, Chromium, Telegram or ChatGPT tests. Reported `541 / 3415`, synthetic Chromium `12 / 81`, fresh-install/sandbox checks and historical live observations remain author evidence and are labeled as such in the acceptance package.

## Practical limits

The approval does not claim live coverage of arbitrary existing conversations, every source format, long generations, future ChatGPT DOM changes, real concurrent conversations or provider cancellation. The real adapter advertises one concurrent conversation and no cancellation; the corresponding conditional core contracts are exercised with fake capabilities. Automatic correlation/resumption of ambiguous provider work remains deferred under the documented conservative UNKNOWN policy.

Publication, merge and MVP tagging are separate operator-authorized actions. This protocol records only the independent verdict for the exact snapshot digests above.

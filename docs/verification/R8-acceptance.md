# R8 — MVP acceptance

Author acceptance: **2026-10-21**, macOS arm64, Bun **1.4.0** (`34cbb9a40`).
Base HEAD: `8fd58ec0498055e6f883fcc3859c9d7d9eb57dcf`, tree
`c895bb9386825f1e7af2ff6f0674589c3ae693ca`. This is the reviewed R7 implementation
from [PR #11](https://github.com/ShabanovBoris/tgcodexweb/pull/11). R8 changes only
acceptance tests and documentation. No runtime code, migration, dependency, retry,
authentication or recovery policy changes.

The matrix covers all **53 AC criteria and four global rules** in
[ACCEPTANCE.md](../../ACCEPTANCE.md). **55 PASS; two conditions do not apply to the
selected real provider**: AC-E04 requires concurrent conversations, and AC-H01
requires confirmed cancellation. Their supported-capability contracts pass against
the fake provider. The real adapter advertises `maxConcurrentConversations=1`,
`fileUpload=true`, `cancellation=false`; no live concurrency/cancellation is claimed.

[R8-evidence.json](R8-evidence.json) contains the executed commands, run summaries,
source hashes and actual passing output for each `Txx` witness below. It is the
sanitized acceptance receipt, not a new live run. Independent review and its exact
snapshot identity are recorded separately in [R8-review.md](R8-review.md).
Publication and an MVP tag require separate operator authorization; neither is
implied by this report.

## Evidence sources

| ID | Source and scope |
| --- | --- |
| I1 | Fresh copy of 182 tracked inputs, no `.git`, real `.env`, existing `node_modules`, database, profile or untracked files. `bun install --frozen-lockfile` used a new cache and installed 14 public packages. `verify`, synthetic browser tests, README `config:check` and first/repeated `bootstrap` ran with network and all user-home reads/writes denied. Explicit probes confirmed both denials. New schema is v7, integrity `ok`, FK errors 0, requests 0; bootstrap did not create a browser profile. |
| S1 | Local security audit: 1,158 available Git objects, including unreachable objects; 544 blobs / 6,632,581 bytes; 182 tracked working files. No actual configured bot token or credential/profile/database path in the checked history. Two token-signature candidates are deliberate test literals containing `SYNTHETIC` or `fixture`, distinct from the working token. Live SQLite inspected read-only: 14 tables / 147 rows / 553 string fields; no auth columns or recognizable credential values, integrity `ok`, FK errors 0. See receipt for exact rules/exclusions. |
| S2 | Source/dependency/import boundary audit plus I1. No unrelated-project import, private/local package reference or OpenAI API generation endpoint in the checked scope. Transport uses the application port; application/domain/ports contain no browser-native or Telegram imports. Real generation uses the provider's browser Send path. |
| L1 | Historical [R6 live receipt](R6.md#live-evidence-and-remaining-limits), 2026-10-17: one initialized conversation, one prompt/PDF, exact canonical re-registration, inaccessible-reference rejection and authenticated native-browser restart. Original checker exited 1 on Markdown-escaped underscores; the observed booleans/hashes and offline exact-answer comparison are preserved there. It is not relabeled as a clean live-script exit. |
| L2 | Historical operator-confirmed R7 checks, 2026-10-21 10:50–10:54 Europe/Moscow, on this base HEAD: `/doctor=READY`, text/image/PDF answers received. Three requests completed and delivered, one provider Send and one delivery attempt each; dedup, cleanup and trace metadata verified. Sanitized public projection is in the R8 receipt; original receipts stay in ignored `data/operations/r7-live-check/`. |
| L3 | Historical controlled restart and backup/restore, 2026-10-21: SIGTERM exit 0, lease release without removing its file, same mappings/selection/UNKNOWN confirmations and 24 unchanged historical requests. Backup restored separately and upgraded 6→7 with integrity/FK checks. Only safe booleans/counts are included in the R8 receipt. |

The source installation needs the documented Bun/browser prerequisites and public
package/browser downloads. The fresh-copy run demonstrates this on macOS arm64;
it does not assert validation of every operating system. Interactive real login
was not repeated in the fresh copy. Authentication persistence is backed by T04
and L1/L3, using the gateway-owned profile without exporting cookies.

## Complete criterion matrix

`Txx` identifies passing output and its test file in the receipt. `PASS` means the
stated behavior was exercised within the listed automated/manual scope; it does
not mean every scenario was repeated against the live service.

| Criterion | Result | Evidence | Demonstrated behavior / applicability |
| --- | --- | --- | --- |
| G1 | PASS | I1, S2 | Install and complete offline/browser verification without access to any user-home project or runtime. |
| G2 | PASS | S2, T09, T13, L1/L2 | Browser provider path; no OpenAI API generation dependency/endpoint in the audited source/dependencies. |
| G3 | PASS | I1, T01, T02, T04, L1 | Fresh declared-dependency install, documented config/bootstrap and auth prerequisites; platform/login limits stated above. |
| G4 | PASS | S1, receipt artifact scan | Acceptance artifacts contain metadata, hashes and synthetic test output; no runtime credentials/profile/DB are published. |
| AC-A01 | PASS | T01 | Missing/invalid config returns stable safe `CONFIG_ERROR` before filesystem effects. |
| AC-A02 | PASS | T02 | Invalid Telegram token rejected before database/browser initialization; distinct from provider authentication. |
| AC-A03 | PASS | T03 | Real adapter + intercepted Chromium session distinguishes unauthenticated state and submits zero prompts. No live logout required. |
| AC-A04 | PASS | T04, L1/L3 | Synthetic browser restart and historical real native-profile restart preserve authentication without cookie export. |
| AC-B01 | PASS | T05 | Allowlisted `/start` returns readiness and required commands. |
| AC-B02 | PASS | T06 | Denied commands/text/attachments and ambiguous senders have zero privileged effects. |
| AC-B03 | PASS | T06 | Authorization/chat policy precede `getFile`, download and storage effects. |
| AC-C01 | PASS | T07, T09, L1 | Named draft initialized without a seed prompt, persisted and selected; first real prompt binds its remote URL. |
| AC-C02 | PASS | T07 | `/new` generates and returns a unique alias. |
| AC-C03 | PASS | T08 | Duplicate/invalid active aliases rejected before remote create/inspect; no second mapping. |
| AC-C04 | PASS | T09, L1 | Access verified, exact inspected canonical identity stored, same remote ID converges after restart. |
| AC-C05 | PASS | T09, L1 | Inaccessible/invalid reference creates no ready mapping. |
| AC-C06 | PASS | T10 | Aliases listed once, active selection identified. |
| AC-C07 | PASS | T10, T12 | `/use` changes only the target of subsequent ordinary input; Telegram replies do not branch. |
| AC-C08 | PASS | T11 | Rename preserves provider identity and rejects another owner's mapping. |
| AC-C09 | PASS | T11 | Local archive frees the alias without remote deletion, historical rebinding or foreign-owner mutation. |
| AC-D01 | PASS | T12, L2 | `2+2?` fixture round trip and historical real Telegram text round trip: one logical request/provider prompt and final delivery. |
| AC-D02 | PASS | T12 | Only selected canonical conversation receives exact ordinary text. |
| AC-D03 | PASS | T13 | Partial text stays running; final completion requires exact correlated terminal evidence. |
| AC-D04 | PASS | T14, T17 | Delivery failure preserves provider completion/dedup and cannot resubmit the provider prompt. |
| AC-D05 | PASS | T15–T18 | Atomic outbox/settlement; SIGKILL recovery; checkpoint/backoff/budget; original authorized destination; expiry; shutdown join. |
| AC-E01 | PASS | T12, T19 | Duplicates before/during/after execution produce one request and one prompt. |
| AC-E02 | PASS | T20 | Three accepted same-key prompts execute in committed FIFO order. |
| AC-E03 | PASS | T20 | No same-key overlap at any mutation/generation barrier. |
| AC-E04 | N/A real; core PASS | T21 | Fake capability 2 permits independent keys; real capability 1 intentionally serializes them. |
| AC-E05 | PASS | T20 | Aliases sharing one exact opaque remote ID share queue ownership. |
| AC-F01 | PASS | T22, L3 | Mappings, active selection and historical references survive reopen/real restart. |
| AC-F02 | PASS | T23 | SIGKILL after queued commit reconstructs only proven safe input and executes it once in order. |
| AC-F03 | PASS | T24/T25 | Interrupted sending, including before fake Send and after submission, becomes UNKNOWN without replay. |
| AC-F04 | PASS | T24/T25 | Interrupted running work without reliable correlation becomes UNKNOWN; successors stay blocked. |
| AC-F05 | PASS | T23–T25 | Actual process kills and repeated-restart tests demonstrate no recovery duplicate. |
| AC-F06 | PASS | T26/T27, L3 | Explicit offline confirmation is durable/idempotent and scoped to one UNKNOWN; invalid/busy paths preserve blockers and input; crash releases lease. |
| AC-G01 | PASS | T28 | Actual source bytes/caption reach the existing provider port once; adapter reads validated ordered bytes. Live source-file scenario not claimed. |
| AC-G02 | PASS | T29, L1/L2 | PDF bytes/metadata bound to one request; historical live PDF-only marker returned. |
| AC-G03 | PASS | T29, L2 | JPEG/PNG upload path, largest photo selection and historical live image response. |
| AC-G04 | PASS | T30 | Metadata and actual streamed size limits reject before provider submission. |
| AC-G05 | PASS | T30 | Count limit rejects deterministically, including excess album files before download. |
| AC-G06 | PASS | T31 | Traversal filename stays display metadata; generated paths and symlink/key checks prevent escape. |
| AC-G07 | PASS | T32, L2 | Successful/TTL cleanup; queued refs protected; album ordering/restart/first mapping/one `/send`; discard/expiry/late groups never submit. |
| AC-H01 | N/A real; core PASS | T33 | Supported fake cancellation checks all terminal kinds, source precedence, foreign evidence, races and capacity ownership. Real cancellation unsupported. |
| AC-H02 | PASS | T34 | No active generation / unsupported cancellation makes zero cancel mutations. |
| AC-H03 | PASS | T35 | Stop preserves accepted successors and one canonical mutation owner. |
| AC-I01 | PASS | T36 | Ordered long Unicode chunks reconstruct the exact source within Telegram's limit. |
| AC-I02 | PASS | T36 | Fences stay atomic when possible; split `<pre>` chunks stay balanced and safe. |
| AC-I03 | PASS | T37 | Only proven parser rejection falls back to plain text for that part; earlier chunks/provider Send never repeat. |
| AC-J01 | PASS | T38, L2 | Readiness requires valid components and a successful poll; reconnection, unknown capacity and storage errors remain non-ready. |
| AC-J02 | PASS | T39 | Browser/provider unavailability cannot report READY. |
| AC-J03 | PASS | T03/T39 | AUTH_REQUIRED remains distinct, including during Telegram outage. |
| AC-J04 | PASS | T40 | CLI/Telegram doctor are read-only; absent DB/profile and busy lease avoid competing initialization; caller IDs scoped; DB errors explicit. |
| AC-K01 | PASS | T41 | Recursive keys, known values, encoded URLs and recognizable auth/cookie headers redacted. |
| AC-K02 | PASS | T42 | Ordinary logs discard arbitrary prompt/response content by default. |
| AC-K03 | PASS | T42, receipt synthetic trace, L2 | New isolated offline trace records all five operations with identical update/request/conversation IDs and one provider submission, without content/credentials. Historical live trace kept separate. |
| AC-K04 | PASS | T43/T44, S1 | Schema/profile boundaries plus read-only live-row inspection show no browser authentication material in application persistence. |

## R8 gap closed

The existing suite killed queued, ambiguous sending, running and post-completion
processes. Uploading and pre-submit interruption had durable-state/reopen coverage,
but no actual RequestService SIGKILL witness. R8 extends the existing crash fixture
with those two boundaries, records actual fake-provider send/submission counts,
and checks durable state before restart, no resend, retained successor/dedup and
terminal input/attachment cleanup afterward.

The uploading barrier is after the durable upload claim and before provider
health/mutation. The pre-submit barrier is inside `send` before the fake performs
any submission. Both report zero provider Send calls/submissions. Restart still chooses
UNKNOWN because no durable provider proof of non-submission survived; no policy is
changed based on the test harness's extra knowledge. Existing post-submission
barriers each report one submission. This is crash-safety evidence, not a change
to provider behavior or a live fault injection.

## Checks and practical limits

- Standard verification includes toolchain, TypeScript, lint, formatting and all
  offline tests. The 12 normally skipped browser cases were executed separately
  with a real local Chromium and intercepted synthetic pages under I1's sandbox.
- Current-worktree and clean-copy results, exact output witnesses and hashes are
  in the receipt. Historical R6/R7 runs are labeled separately and were not
  repeated or counted as new R8 live executions.
- The working runtime retained its lease (PID 86766 observed). R8 did not open
  a competing production profile, poll Telegram, submit a live prompt, invent
  production update IDs, change production data or release historical UNKNOWNs.
- The observed Telegram retry policy remains bounded and exits on prolonged
  outage; no supervisor was added. Automatic provider correlation/resumption and
  UNKNOWN replay remain deferred/forbidden as documented. An ambiguous Telegram
  chunk may repeat under the existing approved delivery policy.
- Live evidence covers bounded scenarios, not arbitrary existing conversations,
  every source format, long generations or all future ChatGPT DOM changes.
- Secret checks cover locally available Git objects, current tracked inputs,
  acceptance artifacts and logical live DB rows. They cannot prove absence of
  every possible secret or inspect remote-only history, freed pages, WAL, private
  backups or browser profile contents. Private runtime auth/config/backups are
  intentionally excluded from published evidence.
- No product/security/recovery decision remains necessary for the checked scope.
  Release operations and MVP tagging remain separate authorized actions.

All changes were made by the root agent; no subagent mutations occurred. The
bounded evidence/coverage passes were local, with no delegated agent wave.

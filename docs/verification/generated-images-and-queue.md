# Generated images, originals and queue commands — 2026-10-21

Task: deliver generated images and downloadable original files, and add queue inspection
and clearing commands. The operator selected `/queue`, `/clearqueue`, `/clearqueue all`
and an original document in Telegram rather than a temporary ChatGPT asset link.

## Result and boundaries

- Image-only responses use correlated gallery/final-control/stability evidence instead
  of requiring text. A running generation, a loaded image alone, or a footer before the
  gallery cannot complete the request. Mixed text and images preserve both outputs.
- PNG/JPEG/WebP output is bounded to four images and 20,000,000 decoded bytes per result.
  Asset reads accept only the observed same-origin content endpoint, forbid redirects,
  enforce streaming limits/deadlines and keep credentials/signed URLs in the provider.
- The Telegram plan sends an eligible photo preview and then `original-N.ext`, captioned
  `Скачать оригинал`. Documents use the exact original bytes without re-encoding. WebP
  and images outside photo constraints receive their original document only. Preview
  eligibility follows the [Telegram sendPhoto contract](https://core.telegram.org/bots/api#sendphoto);
  original files use [sendDocument](https://core.telegram.org/bots/api#senddocument).
- Validated image bytes commit in the existing operational JSON outbox with settlement.
  Each text/photo/document part is checkpointed. Retry never generates another prompt;
  successful delivery or the existing 24-hour expiry removes image content. Existing
  text rows/plans remain readable. No SQL migration was changed or added.
- `/queue` returns the caller's pending IDs/aliases without prompts. `/clearqueue` affects
  only the selected local mapping; `all` affects all owned mappings. An IMMEDIATE
  transaction records `failed / QUEUE_CLEARED` and removes accepted working input.
  Dedup/lifecycle/acceptance history remains; physical cleanup follows commit and respects
  surviving file references. Active/claimed work, foreign work, UNKNOWN and album drafts
  are preserved. `/discard` still controls an unsent album.

## Executed verification

Pinned Bun: **1.4.0**. Final `bun --no-env-file run verify`: **PASS** — toolchain,
TypeScript, lint, formatting, **571 passing tests**, **3616 assertions**, **0 failures**.
The **19 opt-in browser cases** are skipped by that offline command and were then run
explicitly: **19 PASS**, **129 assertions**, **0 failures**. The browser suite uses the
installed local Chrome, isolated temporary profiles and fully intercepted synthetic
ChatGPT/authentication/asset pages. It makes no live provider or Telegram requests.
The six pre-existing lint warnings remain unchanged.

Private execution logs are in ignored `data/operations/generated-images-and-queue-20261021/`:
`verify-final.log` and `browser-final.log`. The earlier `verify.log` also passed, before
the additional mixed-output footer regression check. An initial verification failure
identified stale fork checksums; only the final hashes of the two deliberately patched
files were updated. The provenance test, original upstream revision/blob identities,
dependency pins and migration history checks remain intact.

| Acceptance / invariant | Executed evidence |
| --- | --- |
| AC-M01: image-only/mixed completion, correlation, ordered images, no premature finality | `tests/browser/generated-images.test.ts` — seven real-Chromium synthetic cases |
| AC-M01: approved origins, aggregate byte budget, no URL/error leakage, joined cancellation | `tests/unit/chatgpt-generated-images.test.ts` |
| AC-M01/M02: validated formats/limits and photo eligibility | `tests/unit/generated-images.test.ts` |
| AC-M02: multipart original bytes, core→outbox→Telegram, per-part cursor after reopen, expiry/revocation/cancellation, retry classification | `tests/unit/telegram-generated-images.test.ts` |
| AC-M03: owner/mapping scope, active/UNKNOWN preservation, durable dedup and rollback | `tests/persistence/queue-clear.test.ts` |
| AC-M03: command routing, invalid scope, unauthorized user and duplicate clear suppression | `tests/unit/telegram-queue.test.ts` |
| AC-M03: physical file cleanup after durable removal | `tests/unit/request-attachments.test.ts` — added clear-attachments case |
| Existing text/upload/recovery/security behavior | Entire offline suite plus the existing twelve browser cases |
| Fork provenance | Unchanged `tests/unit/chatgpt-web-fork.test.ts` with refreshed hashes for the documented changes |

## Bounded live observation and remaining limits

The operator explicitly allowed reading the one existing generated-image answer and
checking its download. The observed image-only answer contained a generated gallery,
loaded image, completed turn marker and assistant controls after the gallery, without a
text answer root. The ChatGPT viewer used the same asset source as that gallery. Its
normal Download action produced an original PNG, **1448×1086**, **2,091,792 bytes**.
No new ChatGPT prompt, edit, regeneration or real Telegram upload was performed. This
manual observation confirms the current DOM/download shape; it is not a live round trip
through the new application code. Account/UI changes can require later provider updates.

During that initial feature verification, existing UNKNOWN requests were not recovered
and the working database was only read, retaining its prior states and schema version 7.
Queue commands used temporary test databases. At that point the real gateway was stopped
and LaunchAgent disabled/unloaded. No Git branch/index/commit/push/release operation was
performed.

## Follow-up: stalled Telegram uploads

The operator subsequently reported that a generated image did not arrive. The real
request had already completed and committed one valid PNG, **1448×1086**, **2,280,688
bytes**, to the outbox. Five automatic photo uploads had timed out at the 60-second
deadline without advancing the part cursor. Provider generation was not the failed step.

The original multipart body reached a local HTTP receiver intact. During manual
diagnosis, a buffered variant incorrectly read its Content-Type after consuming a Bun
Response; Telegram explicitly rejected that diagnostic request with HTTP 400 and no
photo. Reading the header before consuming the body corrected that diagnostic mistake.
Telegram then accepted the preview at **17:14:10 UTC**. A subsequent original upload on
the pooled connection timed out. Sending only that remaining document with the existing
native FormData body and `keepalive: false` succeeded at **17:16:36 UTC**; Telegram's
receipt reported `image/png` and **2,280,688 bytes**.

The production correction is confined to media HTTP calls: `sendPhoto`/`sendDocument`
open fresh connections. JSON calls retain pooling. The runtime option is documented by
[Bun's fetch reference](https://bun.sh/docs/runtime/networking/fetch#request-options).
This is a workaround supported by the observed recovery; it does not establish the
underlying Bun/VPN fault or verify every network condition.

Recovery was a guarded manual delivery of the stored output after automatic attempts
stopped. It did not reset the automatic budget or enable retries of failed rows. Each
confirmed part advanced its persisted cursor; the confirmed preview was not sent again
to deliver the document. The final outbox state is `delivered`, cursor **2**, attempts
**6**, with payload/plan removed and no failure code. Hashes of requests, input,
acceptance, attachments, dedup and conversation/selection tables remained unchanged.
SQLite integrity passed and foreign-key violations were zero. No ChatGPT prompt was
submitted during recovery.

Executed follow-up checks:

- Focused Telegram API/image/retry/cancellation tests: **43 PASS**, **0 failures**.
- Full `bun --no-env-file run verify`: **PASS**, **571 passing tests**, **3616 assertions**,
  **20 opt-in cases skipped**, **0 failures**; toolchain/typecheck/lint/format passed.
  The six existing lint warnings are unchanged.
- `TGWEBGPT_TELEGRAM_HTTP_TEST=1 bun --no-env-file test tests/integration/telegram-upload.test.ts`:
  **1 PASS**, **17 assertions**. The loopback HTTP test failed before the correction
  because the photo reused the identity connection. It now proves separate TCP
  connections for both uploads, continued pooling for identity, exact image bytes,
  destination/reply metadata and the original-file caption. It uses a synthetic token,
  no Telegram service and no browser.

Private receipts/logs are in ignored `data/operations/image-delivery-20261021/`:
`before.json`, `buffered-attempt.json`, `manual-receipt.json`,
`manual-receipt-corrected.json`, `original-receipt.json`, `after.json`, `verify.log`.
They contain no token, signed asset URL or image bytes. The corrected gateway was
started manually at **17:20:37 UTC**, PID **24430**. LaunchAgent remains disabled and
unloaded. The provider/browser suite was not rerun for this transport-only correction;
the live receipts prove delivery of the already completed request rather than a new
generation. No Git index/branch/commit/push operation was performed.

## Review correction P1 — 2026-10-22

Independent review of manifest `dd5e0dc7530df37ef1cfd575f0a652a77bc914c19612010711b011a40ba9d725`
and patch `bf0761dbccbd9aa4f887147eaf94489a19fb0759c4f419ff44a148ecbe993b42`
returned REQUEST_CHANGES for one blocking P1. A browser-level failed preview has
`complete=true` and zero natural dimensions. The original readiness boolean treated it
as indefinitely loading, even after the correlated answer's final controls and no Stop,
so the observer deadline could retain UNKNOWN and reserve the sole provider slot.

This is an implementation gap against AC-M01, not a change to its completion contract.
Preview observation now distinguishes loading, loaded and failed. Any in-flight load or
source-less placeholder remains loading. A settled failed gallery still requires final
controls after the gallery, no Stop and the existing stable-content window. It then
completes with `GENERATED_IMAGE_UNAVAILABLE`, without another asset fetch or provider
prompt. The provider port, request lifecycle, UNKNOWN recovery and SQL schema are unchanged.

The real-Chromium synthetic fixture now fails the browser's actual image request with
HTTP 404, HTTP 503 or a network abort. It checks native `complete`/natural dimensions,
completed file-error evidence, zero extra asset reads, cached completion and one prompt.
Separate cases keep an image HTTP response in flight, retain a source-less placeholder,
retain a Stop control or withhold final controls. Negative observations wait longer than the
actual completion stability interval. Existing successful image/ordering/download cases
continue to run. Core→SQLite outbox→Telegram coverage also checks the file-error notice,
duplicate updates and a queued independent conversation with provider capacity one.

Executed on pinned Bun 1.4.0 with the installed local Chromium:

- Before the production correction, the three actual broken-preview cases all failed:
  native image completion was confirmed, but the provider returned UNKNOWN at the deadline.
  This is recorded in private `browser-red.log`; an earlier restricted browser-launch
  attempt is separate and is not used as regression evidence.
- Final `bun --no-env-file run verify`: **594 PASS**, **31 opt-in SKIP**, **0 FAIL**,
  **3709 assertions**. Toolchain, TypeScript, lint and formatting passed; the six existing
  lint warnings remain. The skips are the 28 browser cases and three local HTTP cases.
- Explicit full synthetic Chromium suite: **28 PASS**, **196 assertions**, **0 FAIL**.
  This includes all six new preview regressions and the existing text/upload/composer/
  correlation/Telegram-ingress cases. Profiles are temporary and all network is intercepted.
- Focused file-error/core/media tests: **21 PASS**, **114 assertions**, **0 FAIL**.

Private logs are under ignored `data/operations/generated-preview-fix-20261022/`.
No new live ChatGPT/Telegram request, VPN outage injection, runtime restart, production
DB/profile modification or LaunchAgent operation was performed for this correction.
The existing local HTTP transport checks were not rerun for this provider-only change.
The previous REQUEST_CHANGES is retained above; a new immutable snapshot and independent
fix review are required before claiming that P1 is closed by review.

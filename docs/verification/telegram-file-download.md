# Intermittent Telegram file retrieval — 2026-10-21

The operator reported `ATTACHMENT_UNAVAILABLE` for a photo with a caption, then confirmed
that a subsequent attempt worked. The existing gateway also completed the later request.
The failed ingress did not retain a low-level download trace; the screenshot and later
success cannot establish whether its cause was VPN, Telegram, metadata or storage.

Inspection found that one transient metadata/download failure immediately rejected the
attachment before request acceptance. No read retry existed. The correction addresses
that failure mode without asserting a recovered cause for the original event.

## Change and boundaries

- `TelegramApi.ts` gives `getFile` its own normalized retry hint and retries read-only
  retrieval at most three times, with 1/2-second backoff, inside the existing shared
  30-second download deadline. An explicit valid metadata 429 minimum is respected or
  rejected when it exceeds the remaining budget. No unknown flood minimum is guessed.
- Retries require a recognized transient network error or matching server failure and
  zero bytes yielded to the caller. Starting over after a partial yield would append
  duplicated bytes to the same temporary file, so that path still fails. Failed body
  readers are cancelled/released before waiting. Cancellation preserves the caller's
  original reason. Validation, origin/path/redirect restrictions and size caps remain.
- `AttachmentStore.ts` adds optional fixed diagnostic stages to `AttachmentError`.
  `TelegramBot.ts` logs a final attachment failure with its update/user ID, code and
  stage. It never logs file IDs, URLs, raw exceptions, names, captions or file bytes.
- Normal acceptance/dedup, cleanup, provider submission and UNKNOWN behavior are
  unchanged. A rejected ingress is still marked once; retrying a download does not
  replay its Telegram update or create another ChatGPT prompt.

## Checks executed

- The new API cases before implementation: **7 FAIL**, **4 PASS**. They reproduce
  immediate rejection of transient metadata/body failures and missing diagnostic stages.
- Focused API/collector/storage/queue cases after implementation: **25 PASS**,
  **149 assertions**, **0 failures**. They verify exact bytes/caption, one provider
  submission despite duplicate updates, safe exhaustion diagnostics, temporary-file
  cleanup and acceptance of a later different request.
- Full `bun --no-env-file run verify`: **591 PASS**, **3694 assertions**, **25 opt-in
  cases skipped**, **0 failures**. Toolchain, typecheck, lint and format pass.
- Explicit local HTTP suite: **3 PASS**, **27 assertions**, **0 failures**. Real Bun
  fetch recovers injected metadata/body 503 responses with exact JPEG bytes; the prior
  multipart connection/byte-preservation check also passes. Only loopback is used,
  with synthetic tokens and no live Telegram/ChatGPT calls.

Private verification logs and restart receipts are under ignored
`data/operations/telegram-file-download-20261021/`. No migration, branch, index, commit
or push operation is part of this correction. Existing unrelated working changes remain.

The manual gateway restarted at **18:59:37 UTC**, after the last in-flight request and
its delivery completed. The stop guard required zero active requests and zero pending
deliveries. All eight table snapshots match across restart; integrity is `ok` and there
are zero foreign-key violations. One gateway owns the lease. LaunchAgent remains
disabled/unloaded. No old request was replayed and no active generation was interrupted.

The new policy is proven with deterministic and local HTTP failure injection. A real
VPN outage was not injected, and the original event's exact cause remains unknown.

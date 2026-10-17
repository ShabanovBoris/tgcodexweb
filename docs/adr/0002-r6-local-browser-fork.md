# ADR 0002 — R6 local browser fork

Decision: the user selected “extend the pinned upstream in a local fork” in the R6 chat.
Implementation date: 2026-10-17. Live acceptance remains pending.

The upstream revision remains `fa2d2c6c24926078b46eedb2186f69f2e8d548d7` (`v6.1.3`).
Its public `BrowserTurn` accepts a retained launcher key, not an arbitrary existing
ChatGPT URL. `chatGptPromptFilePayloads` accepts images and selected skill text,
not general PDF/source files. The managed-Chrome path uses a storage-state export;
launcher persistence belongs to its Electron partition. Wrapping those interfaces
alone cannot satisfy this gateway's existing-conversation and dedicated-profile contract.

## Fork boundary and provenance

`src/providers/chatgpt-web/upstream` contains the 31-file browser-worker import
closure, its type declaration, the launcher authentication probe, and MIT license.
`UPSTREAM.json` records every original Git blob SHA, the three patched files, added
gateway files, final SHA-256 values and exact dependency versions from upstream's lock.
The provenance test detects unlisted changes. Original files are not reformatted.
The gateway extension is formatted/linted and the complete closure is typechecked.

The fork adds `ChatGptBrowserWorker.forGateway`, exporting its existing composer,
upload, semantic turn baseline, DOM snapshot and Markdown primitives to an owned
`GatewayBrowserSession`. It extends the existing upload primitive to accept native
file payloads. The original completion tracker and DOM extraction remain reused.
Upload acknowledgement checks the required count for each filename within each UI
representation independently. Two chips with the same name are accepted; one chip
represented by both a group and a button cannot acknowledge two files.
The authentication probe can execute wholly inside the owned page and returns only
its existing authenticated/error projection. No account or auth payload reaches Node.
Gateway composer readback preserves leading whitespace; the Codex path keeps its
original connector-related trimming behavior.

No upstream Responses server, launcher, broker, tunnel, Codex integration, settings
loader, skill compiler, model selector or MCP service is started. Their transitive
source declarations are retained to keep the browser worker an auditable fork.
There is no dependency on another private checkout or its runtime/profile.
Bun 1.4.0 and the R5 dependency pins are unchanged. The added dependencies use the
exact inspected upstream lock versions, including playwright-core 1.62.0.

## Conversation identity and initialization

AC-C01 explicitly permits creation **or initialization**. Upstream starts a new saved
chat at `/`, without a remote conversation URL. `/new` therefore verifies a fresh
saved-chat surface and persists a provider-owned `pending:<uuid>` initialized handle.
It sends no seed prompt. The first user's send must prove one new logical user turn
and a canonical `/c/<uuid>` URL before reporting submitted. The profile registry binds
that URL to the same handle atomically. A later `/add` of that remote URL returns the
same handle, including after restart. Existing remote IDs receive `chatgpt:<uuid>`
handles. These are opaque application keys; they never change after acceptance.

The registry contains only version, handles and remote IDs, not text, response history
or authentication. It lives in the dedicated profile directory with atomic writes.
Create/inspect/send are serialized through binding, preventing `/add` from inventing
a second key during a first send. A binding failure after activation is UNKNOWN.
It never turns into a pre-submit failure or another physical Send.

## Lifecycle and evidence

The browser uses `launchPersistentContext` directly on an independently initialized,
owned directory. Nonempty foreign profiles and symlink roots/metadata are rejected;
directory permissions are 0700 and gateway metadata files are 0600. There is no cookie
export/import, profile handoff, or copying from another project. Interactive login and
normal operation use this same profile. Provider construction follows Telegram token
validation; shutdown joins the application service before closing the browser.

Manual login reuses the pinned upstream's normal Chrome launch, extracted into an
owned-child helper. It waits for complete browser exit before verification; cancellation
terminates and joins only that child. The gateway never calls upstream's authentication
export path. Subsequent native sessions omit Playwright's mock-keychain/basic-password
defaults, matching upstream's login verifier and preserving the browser's native keys.
The manual process has no automation or remote-debugging flags. This follows the
upstream authentication path. The operator's dedicated login subsequently passed real
health before/after restart; the one authorized prompt/PDF also completed. See the
verification receipt for the original answer-format comparison failure and its diagnosis.

Read-only health verifies `/api/auth/session` using the upstream authenticated-session
probe and requires one editable composer. Missing authentication is AUTH_REQUIRED;
network/malformed/session-check/browser failures are unavailable. No diagnostic uploads
or prompts occur, and raw errors/account data are never returned or logged.

The first physical Send activation is the ambiguity boundary. After activation, loss,
missing identities, uncertain URL or errors become UNKNOWN. No adapter retry exists.
Submission uses logical IDs and a pre-send baseline, not display indices or the latest
response. Observation is bound to that exact operation, user turn, remote URL and new
assistant turn; a competing user turn invalidates it. Partial text stays running.
Completion reuses upstream's final-action/no-Stop/stable-content tracker and Markdown
buffer. Aborting observation removes only its local timer/listener and never presses Stop.
No in-memory operation survives restart; inspection then returns UNKNOWN, not latest text.
R2–R5 retention, durable acceptance, FIFO and uncertain-key reservation remain unchanged.

The gateway capability is one concurrent conversation. Upstream's five **launcher** tabs
do not prove this fork's concurrency. Cancellation is disabled: upstream's Stop/AbortError
does not establish a correlated terminal cancellation receipt. `/stop` returns unsupported
through the existing contract. Enabling cancellation/parallelism requires evidence.

## Evidence limits

Normal tests remain offline. `test:browser` is explicit, uses real pinned Chromium with
synthetic DOM/authentication, and intercepts every URL. It cannot prove live selectors,
account access, upload processing or ChatGPT completion behavior. `test:live` is a separate
operator opt-in; sending additionally requires `TGWEBGPT_LIVE_SEND=1`. The bounded live
receipt is recorded separately from synthetic tests. Remaining acceptance checks and
independent review of the final published R6 SHA are still required before R6 exit acceptance.

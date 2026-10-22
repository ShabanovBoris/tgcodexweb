# macOS service verification — 2026-10-21

The operator requested a persistent local runtime, private diagnostics, startup after
login/reboot and process recovery without provider replay. These post-MVP changes are
local; no Git branch/index/history/remote operation was performed for this task.

## Implementation and boundaries

- `scripts/macos-service.ts` prepares a private pinned Bun and LaunchAgent, and records
  the managed process lifecycle around the existing `runCli` entry point.
- The CLI exposes only a boolean restart decision for classified Telegram identity/poll
  read errors with an explicit zero wait. Ordinary CLI exit codes remain 0/1. The service
  uses 75 for a retryable process exit and 0 for a deliberate permanent/operator stop.
  Positive flood minima, delivery hints, invalid tokens, conflicts and unclassified
  errors do not gain an automatic process retry.
- The existing queue, provider, browser adapter, migrations and UNKNOWN recovery policy
  are unchanged. Logger metadata adds PID and exit code; it still excludes raw content.
- The plist is installed under the current user's `~/Library/LaunchAgents/`, uses the
  existing `.env`/database/profile, and starts in that user's GUI session. Launches are
  throttled to one every 30 seconds; graceful shutdown has a 120-second OS limit.

## Automated execution

Pinned Bun **1.4.0**, using the persistent copied binary:

```text
bun --no-env-file run verify
547 pass, 12 opt-in browser skips, 0 fail
3468 assertions, 559 test cases across 47 files
toolchain / TypeScript / lint / format: exit 0
```

Six pre-existing lint warnings remain; no unrelated lint fixes were applied.

The six new tests cover private preparation, XML paths containing spaces/ampersands,
actual `plutil` parsing, idempotent matching preparation, changed-runtime/symlink refusal,
restart classification, normalized fatal/transient CLI results, private lifecycle
records, actual subprocess SIGKILL and joined SIGTERM. Across a managed-process restart,
the fake database retains its UNKNOWN, blocked queued successor/input, active selection
and dedup mappings. The full suite also executes the existing sending/uploading/running
crash, queue, lease, delivery and redaction regressions. Default tests use no live
Telegram/ChatGPT and do not read the production profile.

## Actual isolated launchd exercise

A temporary, separate GUI LaunchAgent ran only the fake fixture with synthetic
credentials and intercepted fetch. Its configuration used the production throttle,
KeepAlive and shutdown settings. It was unloaded after the exercise.

Observed:

1. A classified transient failure returned service exit **75**; launchd restarted it
   after **30.214 seconds** between starts.
2. SIGKILL of that fake process caused another launch after **30.251 seconds**.
3. Graceful `bootout` produced `service.stop_requested / SIGTERM`, joined gateway
   shutdown, then `service.stopped / exit 0`.
4. The fake UNKNOWN and queued successor retained their states; queued input and selected
   conversation remained present, and SQLite quick-check returned `ok`.

The private sanitized receipt is retained at
`data/operations/macos-service-probe-iiwmakvm/receipt.json`. No production request was
created or crashed by this test.

## Local installation and handoff

- Bun was copied byte-for-byte to `data/service/bun-1.4.0/bin/bun`.
- The complete selected Chrome for Testing application was copied to
  `data/service/browser/`. All **326 regular files** and symlink targets matched the
  original; version **151.0.7922.34** was preserved. Only `BROWSER_EXECUTABLE_PATH` changed
  in `.env`; every other configuration byte and its 0600 mode were preserved.
- The former terminal runtime was idle, with no pending deliveries, before SIGTERM.
  Its CLI finished with exit 0. The same database/profile then passed read-only doctor:
  configuration, Telegram and provider ready, migrations 7/7, no queued/blocked requests
  or pending deliveries. No new prompt was submitted.
- The generated and installed plist bytes matched. Service directories are 0700,
  plist/logs 0600 and the pinned Bun 0500. Browser resources retain their original
  permissions inside a private directory. A 14-file exact known-token scan, including
  generated logs and installed plist, found zero raw/URL-encoded/base64 matches.

The initial LaunchAgent process received SIGTERM and was unloaded after 38 seconds.
System logs and Background Task Management then showed this specific item as
`enabled, disallowed, notified`. The operator explicitly authorized background execution;
the **Jarred Sumner** switch was changed to **on** in System Settings, and macOS
automatically registered/launched the service again. The diagnostic `sfltool dumpbtm`
requested administrator authorization, which the operator completed locally; no password
was read or stored by the agent. No unrelated background item was changed.

At **12:53:30 UTC**, the resulting process **PID 5733** had run for **136 seconds**,
was the sole database/lease owner, and had no CLI failures. SQLite integrity returned
`ok`, FK errors 0, pending deliveries 0. States remained **26 completed / 1 failed /
2 UNKNOWN**. Hashes of all rows in requests, conversation mappings, active selections,
UNKNOWN resolutions and processed updates matched the pre-handoff snapshot. No UNKNOWN
was replayed. Private before/after metadata receipts live in `data/service/`.

## Limits

- Startup after actual OS reboot was not exercised; the installed LaunchAgent starts
  after GUI login, and cannot run while the machine is powered off/asleep or logged out.
- The browser adapter was unchanged; no new live generation or browser-DOM acceptance
  run was performed. Doctor was a read-only health check.
- Earlier terminal-runtime exits still lack evidence establishing their exact cause.
  The diagnosed background permission belongs to this new LaunchAgent incident.
- A hard kill/power failure cannot write its own closing receipt. An unmatched start
  proves an unclean exit, not the exact cause. Logs append; rotation is operator-managed.
- Corrected permanent failures need an explicit operator start; service exit 0 alone
  does not establish READY. See the [operations procedure](../operations/macos-service.md).

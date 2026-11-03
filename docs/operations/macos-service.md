# Persistent macOS service

This optional operator installation uses the current user's GUI LaunchAgent. It starts
after login, including the first login after reboot, and stops at logout. It cannot keep
the Mac awake or provide service while it is shut down. It runs the repository checkout;
moving/deleting that checkout requires preparing and installing a new plist.

## Prepare

Complete the normal README installation, bootstrap and dedicated-profile authentication
first. Keep `.env` private (0600). Use the exact Bun version pinned in `package.json`:

```sh
bun --env-file=.env scripts/macos-service.ts prepare
```

Preparation copies that running Bun binary to `data/service/bun-<version>/bin/bun`,
creates private stdout/stderr files and generates
`data/service/io.github.shabanovboris.tgwebcodex.plist`. It does not start a bot, inspect
the profile, open/migrate the database or contact Telegram. Repeating preparation accepts
the same bytes; a different existing executable/plist or unsafe path fails closed.

Also place the selected browser application outside `/tmp` and `/private/tmp`. On macOS,
copy the entire Chrome for Testing `.app` bundle, including its Frameworks/resources;
preserve the exact version used for verification. Update only `BROWSER_EXECUTABLE_PATH`
in `.env` to its executable, retaining the dedicated `BROWSER_PROFILE_DIR`. Do not copy
authentication state into application configuration or the service plist.

## Install and start

Stop any existing terminal bot gracefully and wait for its process and gateway lease to
close. Do not remove a lock file or force-kill a bot merely to install the service.
Run the read-only doctor with the prepared Bun while no runtime owns the lease:

```sh
data/service/bun-1.4.0/bin/bun --env-file=.env src/cli/index.ts doctor
```

From the repository root, install the generated file (inspect an existing installation
before replacing it):

```sh
service_label=io.github.shabanovboris.tgwebcodex
service_domain="gui/$(id -u)"
mkdir -p "$HOME/Library/LaunchAgents"
install -m 600 "data/service/$service_label.plist" "$HOME/Library/LaunchAgents/$service_label.plist"
launchctl bootstrap "$service_domain" "$HOME/Library/LaunchAgents/$service_label.plist"
```

The plist includes only executable/config/log paths and a minimal PATH. It never embeds
the bot token, allowed user IDs or browser credentials. Data/service directories are 0700,
logs/plist 0600, and the pinned executable 0500. The browser bundle retains its original
application permissions inside private parent directories.

macOS Login Items may display this legacy LaunchAgent as **bun**, the executable name.
Its identifier is `io.github.shabanovboris.tgwebcodex`; inspect that identifier/path before
changing its background permission. Disabling the item can unload the job and send SIGTERM,
which is an operator/system stop rather than a Telegram/provider failure.

## Failure and stop policy

The service calls the existing `runCli(["start", "--private"])` in its own process and
keeps the same database lease, provider ownership and joined signal shutdown. It never
implements an independent queue or retries a provider prompt. UNKNOWN remains blocked
until the existing explicit offline operator confirmation.

Normal CLI commands still return 0/1. The launchd adapter returns **75** to request a new
process after an exhausted, classified Telegram identity/poll read with a zero minimum
(for example allowlisted network/timeout/5xx failures). Launchd throttles launches to no
more than one every 30 seconds. It also restarts a process terminated abnormally.

The adapter deliberately returns **0** to stop supervision after a permanent/unclassified
error, configuration/storage error, invalid token, poller/webhook conflict, any positive
flood minimum, or an operator SIGINT/SIGTERM. This **does not mean READY or successful
application startup**: `cli.failed` retains the failure and `service.stopped` records
`permanent_failure`. A fresh process must not turn an exhausted server wait into an early
retry. Fix the cause, then start the already loaded job without killing another instance:

```sh
launchctl kickstart "gui/$(id -u)/io.github.shabanovboris.tgwebcodex"
```

For a graceful stop/unload:

```sh
launchctl bootout "gui/$(id -u)/io.github.shabanovboris.tgwebcodex"
```

Wait for the lease/process to close before offline maintenance or another start. Launchd
allows 120 seconds for shutdown before forced termination; ambiguity still becomes UNKNOWN
at the next start. To restart after unloading, use `bootstrap` again. Avoid `kickstart -k`
for routine restarts. To keep the service disabled across logins, use `launchctl disable`
for that exact service target, or remove its installed plist after unloading. Re-enable
the exact target before loading it again. No root/system daemon installation is needed.

## Diagnose

```sh
launchctl print "gui/$(id -u)/io.github.shabanovboris.tgwebcodex"
tail -n 30 data/service/lifecycle.jsonl
tail -n 50 data/service/stderr.log
```

`lifecycle.jsonl` contains synced `service.started`, `service.stop_requested` and
`service.stopped` records with timestamps, PID, duration, service exit code and fixed
reason. `stderr.log` contains the existing redacted application trace, including the
normalized failure before an exit. Stdout is retained separately. These are operator
files, not public receipts; request IDs and aliases may be private metadata.

SIGKILL, power loss and a native runtime crash cannot reliably write an ending record.
An unmatched start therefore means **unclean termination; exact cause unknown**. Inspect
the OS's last-exit/signal diagnostics and relevant crash reports locally. `launchctl print`
is a diagnostic view, not a stable machine API; process presence also does not establish
gateway READY. Use Telegram `/doctor` for the owned running provider. CLI doctor skips a
competing browser probe while the lease is busy.

Logs append across runs. Stop/unload the service before archiving/truncating its logs so
launchd reopens the files; preserve private permissions. Automatic log rotation and a full
OS reboot test are not provided by the preparation command.

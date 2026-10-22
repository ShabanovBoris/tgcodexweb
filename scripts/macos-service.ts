import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import manifest from "../package.json" with { type: "json" };
import { runCli } from "../src/cli/index";
import { type Environment, loadConfig } from "../src/config/Config";
import { createLogger } from "../src/logging/logger";
import { checkToolchain } from "./check-toolchain";

export const serviceLabel = "io.github.shabanovboris.tgwebcodex";

function privateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("SERVICE_PATH_UNSAFE");
  chmodSync(path, 0o700);
}

function privateAppendFile(path: string): number {
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error("SERVICE_PATH_UNSAFE");
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  fchmodSync(fd, 0o600);
  return fd;
}

function serviceDirectory(root: string): string {
  privateDirectory(join(root, "data"));
  const directory = join(root, "data/service");
  privateDirectory(directory);
  return directory;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// Preparation never starts admission or opens the DB/profile; the generated job references the existing private .env.
export function prepareMacOSService(root: string, runtimeSource = process.execPath) {
  checkToolchain();
  root = resolve(root);
  const envPath = join(root, ".env");
  const envEntry = lstatSync(envPath);
  if (!envEntry.isFile() || envEntry.isSymbolicLink() || (envEntry.mode & 0o077) !== 0)
    throw new Error("SERVICE_ENV_NOT_PRIVATE");
  const directory = serviceDirectory(root);
  const runtimeDirectory = join(directory, `bun-${manifest.engines.bun}`);
  privateDirectory(runtimeDirectory);
  privateDirectory(join(runtimeDirectory, "bin"));
  const bunPath = join(runtimeDirectory, "bin/bun");
  if (existsSync(bunPath)) {
    if (!lstatSync(bunPath).isFile()) throw new Error("SERVICE_PATH_UNSAFE");
    const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    if (digest(bunPath) !== digest(runtimeSource)) throw new Error("SERVICE_RUNTIME_MISMATCH");
  } else copyFileSync(runtimeSource, bunPath, constants.COPYFILE_EXCL);
  chmodSync(bunPath, 0o500);
  const stdoutPath = join(directory, "stdout.log");
  const stderrPath = join(directory, "stderr.log");
  for (const path of [stdoutPath, stderrPath]) closeSync(privateAppendFile(path));
  const plistPath = join(directory, `${serviceLabel}.plist`);
  const args = [bunPath, `--env-file=${envPath}`, join(root, "scripts/macos-service.ts"), "run"];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${serviceLabel}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(dirname(bunPath))}:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>120</integer>
<key>AbandonProcessGroup</key><false/>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(stdoutPath)}</string>
<key>StandardErrorPath</key><string>${xml(stderrPath)}</string>
</dict></plist>
`;
  if (existsSync(plistPath)) {
    if (!lstatSync(plistPath).isFile() || readFileSync(plistPath, "utf8") !== plist)
      throw new Error("SERVICE_PLIST_EXISTS");
  } else writeFileSync(plistPath, plist, { flag: "wx", mode: 0o600 });
  chmodSync(plistPath, 0o600);
  return { directory, bunPath, plistPath, stdoutPath, stderrPath };
}

// launchd owns process supervision; this boundary records its lifecycle and preserves runCli's joined shutdown.
// Exit 75 requests restart. Exit 0 deliberately stops supervision after a permanent application error or operator stop.
export async function runManagedGateway(
  root: string,
  env: Environment,
  execute = (onFailure: (restartable: boolean) => void) =>
    runCli(["start", "--private"], env, root, onFailure),
): Promise<number> {
  process.umask(0o077);
  const fd = privateAppendFile(join(serviceDirectory(root), "lifecycle.jsonl"));
  const log = createLogger({
    knownSecrets: [env.TELEGRAM_BOT_TOKEN?.trim() ?? ""],
    sink: (line) => {
      writeSync(fd, line);
      fsyncSync(fd);
    },
  });
  const processId = process.pid;
  const started = Date.now();
  let signal: "SIGINT" | "SIGTERM" | undefined;
  const capture = (received: "SIGINT" | "SIGTERM") => {
    if (signal) return;
    signal = received;
    // Diagnostics must not interrupt the CLI's independent signal handler if the disk fills during shutdown.
    try {
      log("info", { operation: "service.stop_requested", processId, reason: signal });
    } catch {
      /* runCli still owns cancellation. */
    }
  };
  const interrupt = () => capture("SIGINT");
  const terminate = () => capture("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    log("info", { operation: "service.started", processId });
    let restartable = false;
    const applicationExit = await execute((value) => {
      restartable = value;
    });
    const exitCode = applicationExit !== 0 && restartable && !signal ? 75 : 0;
    log(applicationExit === 0 ? "info" : "error", {
      operation: "service.stopped",
      processId,
      exitCode,
      reason:
        applicationExit === 0
          ? (signal ?? "completed")
          : restartable
            ? "retryable_failure"
            : "permanent_failure",
      durationMs: Date.now() - started,
    });
    return exitCode;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    closeSync(fd);
  }
}

if (import.meta.main) {
  const command = process.argv[2];
  try {
    const root = resolve(import.meta.dir, "..");
    if (command === "prepare" && process.platform === "darwin" && process.argv.length === 3) {
      loadConfig(process.env, root);
      process.stdout.write(
        `${JSON.stringify({ operation: "service.prepared", ...prepareMacOSService(root) })}\n`,
      );
    } else if (command === "run" && process.argv.length === 3) {
      process.exitCode = await runManagedGateway(root, process.env);
    } else throw new Error("SERVICE_COMMAND_INVALID");
  } catch {
    createLogger()("error", {
      operation: "service.failed",
      errorCode: "SERVICE_ERROR",
      reason: command === "prepare" ? "preparation_failed" : "startup_failed",
    });
    process.exitCode = command === "run" ? 0 : 1;
  }
}

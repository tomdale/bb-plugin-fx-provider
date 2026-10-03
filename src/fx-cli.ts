import { spawn, type ChildProcess } from "node:child_process";

/** The parts of the ACP launch spec that say how to run fx on this host. */
export interface FxLaunch {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd?: string;
}

export interface FxCliInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * The launch spec starts the agent as `<command> [...prefix] acp`. fx's other
 * subcommands run with the same command, prefix, directory and environment,
 * so they see the same fx installation, profile and credentials as the agent.
 */
export function fxCliInvocation(
  launch: FxLaunch,
  subcommand: readonly string[],
): FxCliInvocation {
  const prefix =
    launch.args.at(-1) === "acp" ? launch.args.slice(0, -1) : launch.args;
  return {
    command: launch.command,
    args: [...prefix, ...subcommand],
    cwd: launch.cwd ?? process.cwd(),
    env: fxEnv(launch.env),
  };
}

/**
 * The environment the shared bridge gives fx: the bridge's own, minus the
 * variables that only configure the bridge runtime, plus the launch spec's.
 */
function fxEnv(
  launchEnv: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BB_PROVIDER_BRIDGE_RECORD_DIR;
  return { ...env, ...launchEnv };
}

export type FxCliResult =
  | { kind: "exited"; exitCode: number | null; stdout: string; stderr: string }
  | { kind: "missing-executable"; message: string }
  | { kind: "failed-to-start"; message: string }
  | { kind: "timed-out"; timeoutMs: number };

const MAX_STDOUT_CHARS = 4 * 1024 * 1024;
const MAX_STDERR_CHARS = 16 * 1024;

/**
 * Runs short fx queries with a deadline. Each query runs in its own process
 * group, which the deadline or `close()` kills whole, so an fx that hangs
 * (or a wrapper script around it) never outlives the request or the bridge.
 */
export function createFxCliRunner(options: { timeoutMs: number }) {
  const running = new Set<ChildProcess>();
  const kill = (child: ChildProcess) => {
    try {
      if (process.platform !== "win32" && child.pid !== undefined) {
        process.kill(-child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      // Already exited.
    }
  };
  return {
    run(invocation: FxCliInvocation): Promise<FxCliResult> {
      return new Promise((resolve) => {
        let child: ChildProcess;
        try {
          child = spawn(invocation.command, invocation.args, {
            cwd: invocation.cwd,
            env: invocation.env,
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
            windowsHide: true,
          });
        } catch (error) {
          resolve(startFailure(error));
          return;
        }
        running.add(child);
        let stdout = "";
        let stderr = "";
        child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
          if (stdout.length < MAX_STDOUT_CHARS) stdout += chunk;
        });
        child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
        });
        let settled = false;
        const settle = (result: FxCliResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          running.delete(child);
          resolve(result);
        };
        const timer = setTimeout(() => {
          kill(child);
          settle({ kind: "timed-out", timeoutMs: options.timeoutMs });
        }, options.timeoutMs);
        child.on("error", (error) => {
          kill(child);
          settle(startFailure(error));
        });
        child.on("close", (exitCode) => {
          settle({ kind: "exited", exitCode, stdout, stderr });
        });
      });
    },
    close(): void {
      for (const child of running) kill(child);
      running.clear();
    },
  };
}

function startFailure(error: unknown): FxCliResult {
  const message = error instanceof Error ? error.message : String(error);
  // Node reports an executable missing from PATH (or a missing absolute path)
  // as ENOENT from a `spawn` syscall, which is how the SDK classifies it too.
  return error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ENOENT" &&
    String((error as NodeJS.ErrnoException).syscall ?? "").startsWith("spawn")
    ? { kind: "missing-executable", message }
    : { kind: "failed-to-start", message };
}

/** The JSON object an fx `--json` subcommand printed, if it printed one. */
export function parseFxJson(
  stdout: string,
): Record<string, unknown> | undefined {
  const text = stdout.trim();
  // fx prints one JSON line; lines before it are diagnostic output.
  const candidates = [text, ...text.split("\n").reverse()];
  for (const candidate of candidates) {
    if (!candidate.trimStart().startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(candidate);
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Not the JSON output.
    }
  }
  return undefined;
}

/** `fx models --json`: the model ids this fx account can select. */
export interface FxModelListing {
  ids: string[];
  /**
   * fx names a source per model only when the active provider is not the
   * Vercel AI Gateway (a Codex or Grok subscription or a configured provider).
   */
  namesSources: boolean;
}

export function parseFxModelListing(
  json: Record<string, unknown> | undefined,
): FxModelListing | undefined {
  if (json?.kind !== "models" || !Array.isArray(json.ids)) return undefined;
  const ids = [
    ...new Set(
      json.ids.filter(
        (id): id is string => typeof id === "string" && id !== "",
      ),
    ),
  ];
  return { ids, namesSources: Array.isArray(json.models) };
}

/** `fx status --json`: the configured model and credential state. */
export interface FxStatus {
  model: string | undefined;
  /** The active credential source ("fx login", "AI_GATEWAY_API_KEY", …) or "missing". */
  auth: string | undefined;
  authExpired: boolean;
  authRefreshable: boolean;
  authHelp: string | undefined;
  /** Set only when the active provider is not the Vercel AI Gateway. */
  modelSource: string | undefined;
}

export function parseFxStatus(
  json: Record<string, unknown> | undefined,
): FxStatus | undefined {
  if (json?.kind !== "status") return undefined;
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  return {
    model: text(json.model),
    auth: text(json.auth),
    authExpired: json.auth_expired === true,
    authRefreshable: json.auth_refreshable === true,
    authHelp: text(json.auth_help),
    modelSource: text(json.model_source),
  };
}

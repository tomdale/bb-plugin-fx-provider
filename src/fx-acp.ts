import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import {
  FX_EDIT_ROOTS_ENV,
  findBbToolServer,
  fxToolCallMcpIdentity,
  isBbToolCall,
  isFxWorkspaceEdit,
  physicalPath,
  readFxEditGrant,
  type FxBbToolServer,
} from "./fx-permissions.js";
import { FxTranscript } from "./fx-transcript.js";
import { normalizeFxToolResult } from "./fx-tool-results.js";

/**
 * fx returns both `provider` and `model` with category `model`, provider first.
 * The shared bridge selects the first model-category option. Preserve every
 * option and value, but put the actual model first in responses and updates.
 */
export function normalizeFxConfigOptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeFxConfigOptions);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (key === "configOptions" && Array.isArray(item)) {
      const model = item.findIndex((option) => option?.id === "model");
      result[key] =
        model > 0
          ? [item[model], ...item.slice(0, model), ...item.slice(model + 1)]
          : item;
    } else {
      result[key] = normalizeFxConfigOptions(item);
    }
  }
  return result;
}

/** fx's names for the ACP stop reasons it reports under its own spelling. */
const FX_STOP_REASONS: Record<string, string> = {
  refused: "refusal",
  max_output_tokens: "max_tokens",
  max_model_turns: "max_turn_requests",
};

/** Translates fx's stop reason spellings to the ones ACP specifies. */
export function normalizeFxMessage(value: unknown): unknown {
  const message = normalizeFxConfigOptions(value);
  if (
    message !== null &&
    typeof message === "object" &&
    !Array.isArray(message)
  ) {
    const result = (message as Record<string, unknown>).result;
    if (
      result !== null &&
      typeof result === "object" &&
      !Array.isArray(result)
    ) {
      const fields = result as Record<string, unknown>;
      const reason = fields.stopReason;
      if (
        typeof reason === "string" &&
        Object.hasOwn(FX_STOP_REASONS, reason)
      ) {
        fields.stopReason = FX_STOP_REASONS[reason];
      }
    }
  }
  return message;
}

/** Session updates the adapter reads; every other update passes through raw. */
const INSPECTED_UPDATES = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
]);

/**
 * The `sessionUpdate` of an fx `session/update` line, read without parsing.
 * Quotes inside JSON strings are escaped and fx writes this field before the
 * update's nested values, so its first occurrence is the update's own. A
 * misread only skips inspection of a stream update; permission requests and
 * responses are always parsed.
 */
function sessionUpdateKind(line: string): string | undefined {
  if (!line.includes('"method":"session/update"')) return undefined;
  const marker = '"sessionUpdate":"';
  const start = line.indexOf(marker);
  if (start === -1) return undefined;
  const end = line.indexOf('"', start + marker.length);
  return end === -1 ? undefined : line.slice(start + marker.length, end);
}

type JsonRpcId = string | number;
type Message = Record<string, unknown>;

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number";
}

function record(value: unknown): Message | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Message)
    : undefined;
}

/** What one line from fx turns into. */
export interface FxAgentLineResult {
  /** The line to send on to the shared bridge, if any. */
  bridge?: string;
  /** A reply the adapter sends back to fx itself, if any. */
  agent?: string;
}

/**
 * The per-session state between the shared bridge and one `fx acp` process.
 *
 * Permission requests are answered here only when BB's policy already
 * decides them: BB's own dynamic tools, and, while host.ts grants it, fx file
 * edits inside the write roots. Every other request reaches the bridge, which
 * applies the thread's permission mode and asks the user. Requests are
 * answered here only during a running prompt that has not been cancelled,
 * where the bridge would also consider them; otherwise the bridge answers
 * them as cancelled.
 */
export class FxAcpAdapter {
  private workspace: string | undefined;
  private bbTools: FxBbToolServer | undefined;
  private sessionId: unknown;
  private readonly prompts = new Set<JsonRpcId>();
  private cancelled = false;
  private readonly mcpIdentities = new Map<
    string,
    { server: string; tool: string }
  >();
  /**
   * Whether this fx names MCP servers on its tool calls. Once it does, a call
   * without that identity is not matched by its alias, which another
   * server's tool can share (fx joins server and tool names with `_`).
   */
  private sendsMcpIdentity = false;
  private readonly transcript = new FxTranscript();

  /** @param editRoots The host's edit grant: extra write roots, or none. */
  constructor(private readonly editRoots: readonly string[] | undefined) {}

  /** Observes a line the bridge sends to fx. The line is forwarded as is. */
  fromBridge(line: string): void {
    if (!line.includes('"method":"session/')) return;
    let message: Message | undefined;
    try {
      message = record(JSON.parse(line));
    } catch {
      return;
    }
    const params = record(message?.params);
    switch (message?.method) {
      case "session/new":
      case "session/load":
      case "session/resume":
      case "session/fork": {
        const cwd = params?.cwd;
        this.workspace =
          typeof cwd === "string" && isAbsolute(cwd)
            ? physicalPath(cwd)
            : undefined;
        this.bbTools = findBbToolServer(params?.mcpServers);
        this.mcpIdentities.clear();
        return;
      }
      case "session/prompt":
        if (isId(message.id)) this.prompts.add(message.id);
        this.sessionId = params?.sessionId;
        this.cancelled = false;
        this.mcpIdentities.clear();
        this.transcript.reset();
        return;
      case "session/cancel":
        this.cancelled = true;
        return;
    }
  }

  /** Processes one line from fx. */
  fromAgent(line: string): FxAgentLineResult {
    const kind = sessionUpdateKind(line);
    if (
      kind !== undefined &&
      !INSPECTED_UPDATES.has(kind) &&
      !line.includes('"configOptions"')
    ) {
      return { bridge: line };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Preserve malformed output so the shared bridge reports the error.
      return { bridge: line };
    }
    const message = record(parsed);
    if (message === undefined) return { bridge: line };

    if (message.method === "session/request_permission" && isId(message.id)) {
      const optionId = this.autoApproval(record(message.params));
      if (optionId !== undefined) {
        return {
          agent: JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { outcome: { outcome: "selected", optionId } },
          }),
        };
      }
    }

    let changed = false;
    if (message.method === undefined && isId(message.id)) {
      if (this.prompts.delete(message.id)) this.transcript.reset();
      if (line.includes('"stopReason"')) changed = true;
    }
    if (message.method === "session/update") {
      const params = record(message.params);
      const update = record(params?.update);
      if (params !== undefined && update !== undefined) {
        if (update.sessionUpdate === "tool_call") {
          const identity = fxToolCallMcpIdentity(update);
          if (identity !== undefined && typeof update.toolCallId === "string") {
            this.mcpIdentities.set(update.toolCallId, identity);
            this.sendsMcpIdentity = true;
          }
        }
        const rewritten = normalizeFxToolResult(this.transcript.rewrite(update));
        if (rewritten !== update) {
          params.update = rewritten;
          changed = true;
        }
      }
    }
    if (line.includes('"configOptions"')) changed = true;
    return {
      bridge: changed ? JSON.stringify(normalizeFxMessage(message)) : line,
    };
  }

  /** The allow-once option to answer a permission request with, if any. */
  private autoApproval(params: Message | undefined): string | undefined {
    if (params === undefined || this.prompts.size === 0 || this.cancelled) {
      return undefined;
    }
    if (params.sessionId !== this.sessionId) return undefined;
    const options = Array.isArray(params.options) ? params.options : [];
    const allowOnce = options
      .map(record)
      .find((option) => option?.kind === "allow_once")?.optionId;
    if (typeof allowOnce !== "string") return undefined;
    const toolCall = record(params.toolCall);
    if (toolCall === undefined) return undefined;
    if (this.bbTools !== undefined) {
      const id = toolCall.toolCallId;
      const identity =
        typeof id === "string" ? this.mcpIdentities.get(id) : undefined;
      if (
        (identity !== undefined || !this.sendsMcpIdentity) &&
        isBbToolCall(toolCall, this.bbTools, identity)
      ) {
        return allowOnce;
      }
    }
    if (this.editRoots !== undefined && this.workspace !== undefined) {
      const roots = [this.workspace, ...this.editRoots];
      if (isFxWorkspaceEdit(toolCall, this.workspace, roots)) return allowOnce;
    }
    return undefined;
  }
}

/** Runs only when the host artifact is executed explicitly in adapter mode. */
export function runFxAcp(command: string, args: string[]): void {
  const adapter = new FxAcpAdapter(readFxEditGrant(process.env));
  // The grant and the Electron runtime switch are for this process only; fx
  // and the commands it runs get the environment the shared bridge chose.
  const env = { ...process.env };
  delete env[FX_EDIT_ROOTS_ENV];
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env,
  });
  // A disappearing ACP process must not turn a late stdin write into an
  // unhandled EPIPE. The child's exit/error determines our exit status.
  child.stdin.on("error", () => {});
  const input = createInterface({ input: process.stdin });
  // Bridge lines and the adapter's own replies share fx's stdin, so both are
  // written as whole lines.
  let draining = false;
  const toAgent = (line: string) => {
    if (!child.stdin.write(`${line}\n`) && !draining) {
      draining = true;
      input.pause();
      child.stdin.once("drain", () => {
        draining = false;
        input.resume();
      });
    }
  };
  input.on("line", (line) => {
    adapter.fromBridge(line);
    toAgent(line);
  });
  input.on("close", () => child.stdin.end());
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const { bridge, agent } = adapter.fromAgent(line);
    if (agent !== undefined) toAgent(agent);
    if (bridge !== undefined && !process.stdout.write(`${bridge}\n`)) {
      child.stdout.pause();
    }
  });
  process.stdout.on("drain", () => child.stdout.resume());
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    console.error(`Cannot start fx ACP: ${error.message}`);
    process.exitCode = 1;
    process.stdin.destroy();
  });
  child.on("close", (code, signal) => {
    lines.close();
    process.exitCode = code ?? (signal ? 1 : 0);
    process.stdin.destroy();
  });
}

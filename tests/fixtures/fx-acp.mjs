// A deterministic ACP peer for testing the plugin's shared-bridge wiring.
// It never calls a model or executes the tool described in a permission request.
// Fork is implemented to exercise the shared bridge's handshake capabilities;
// the plugin declaration independently disables forks for real fx sessions.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

let sessionId;
let sessionMcpServers = [];
// Settles when the client cancels the running prompt.
let cancelled = Promise.resolve();
let cancelPrompt = () => {};
let model = "account-default";
let effort = "auto";
const nativeReasoning = process.env.FX_FIXTURE_REASONING === "1";
const pending = new Map();
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const configOptions = () => [
  ...(nativeReasoning && model === "alternate"
    ? [
        {
          id: "effort",
          name: "Reasoning Effort",
          category: "thought_level",
          type: "select",
          currentValue: effort,
          options: ["auto", "low", "medium", "high"].map((value) => ({
            value,
            name: value,
          })),
        },
      ]
    : []),
  {
    // Real fx 0.0.7 returns this before the actual model, with the same category.
    id: "provider",
    name: "Provider",
    category: "model",
    type: "select",
    currentValue: "gateway",
    options: [{ value: "gateway", name: "Vercel AI Gateway" }],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: model,
    options: [
      { value: "account-default", name: "Account default" },
      { value: "alternate", name: "Alternate" },
    ],
  },
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "ask",
    options: [
      { value: "ask", name: "Ask" },
      { value: "code", name: "Code" },
    ],
  },
];
const update = (text) =>
  send({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });

// Payload shapes below are copied from real fx 0.0.10 and 0.0.12 traffic.
const FX_PERMISSION_OPTIONS = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  {
    optionId: "allow_always",
    name: "Allow for this session",
    kind: "allow_always",
  },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];
const FX_SKILL_WARNING =
  'skill discovery warning: candidate "/home/fixture/.claude/skills/broken" was skipped because its metadata is invalid (unsupported_multiline); use one safe name and an optional inline description or a >, >-, or | block, then reload skills; relaunch with FX_TRACE=1 to write a trace log';
const FX_CONTEXT_NOTICE =
  '[context] MCP description for "mcp_bb-bridge_AskUserQuestion" truncated: observed=1435 bytes effective=1024 bytes source=compiled default; override with --context-limit mcp_description_bytes=BYTES|off\n';
let requestSerial = 0;

const sessionUpdate = (update) =>
  send({ method: "session/update", params: { sessionId, update } });
const messageChunk = (messageId, text) =>
  sessionUpdate({
    sessionUpdate: "agent_message_chunk",
    messageId,
    content: { type: "text", text },
  });

/** Announces a tool call and asks for permission, as fx does in ask mode. */
async function requestToolPermission({ name, title, kind, rawInput }) {
  const toolCallId = `call_${randomUUID()}`;
  sessionUpdate({
    sessionUpdate: "tool_call",
    toolCallId,
    name,
    title: kind === "edit" ? "Writing" : title,
    kind,
    status: "pending",
    rawInput,
  });
  const id = ++requestSerial;
  const result = new Promise((resolve) => pending.set(id, resolve));
  send({
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: { toolCallId, name, title, kind, status: "pending", rawInput },
      options: FX_PERMISSION_OPTIONS,
    },
  });
  const answer = await result;
  const outcome = answer.outcome?.optionId ?? answer.outcome?.outcome;
  sessionUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: outcome === "allow_once" ? "completed" : "failed",
  });
  return outcome;
}

/** The fx name of a BB dynamic tool, from the MCP config BB passed in. */
function bbToolAlias(tool) {
  const server = sessionMcpServers.find((config) =>
    config.env?.some((entry) => entry.name === "BB_ACP_DYNAMIC_TOOLS"),
  );
  return server ? `mcp_${server.name}_${tool}` : undefined;
}

/** Prompt-driven approval and transcript scenarios. Returns the stop reason. */
async function approvalScenario(text) {
  let match;
  if (text.includes("mcp-result-display")) {
    const toolCallId = `call_${randomUUID()}`;
    sessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId,
      name: "mcp_bb-bridge_todo",
      title: "mcp_bb-bridge_todo",
      kind: "other",
      status: "pending",
      rawInput: { action: "list" },
    });
    const rawOutput = JSON.stringify({
      server: "bb-bridge",
      tool: "mcp_bb-bridge_todo",
      result: { content: [{ type: "text", text: "First task\nSecond task" }] },
    });
    sessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      rawOutput,
      content: [{ type: "content", content: { type: "text", text: rawOutput } }],
    });
    return "end_turn";
  }
  if ((match = /\bedit-permission (\S+)/.exec(text))) {
    const outcome = await requestToolPermission({
      name: "write_file",
      title: "file_mutation",
      kind: "edit",
      rawInput: { path: match[1], content: "fixture\n" },
    });
    update(`edit-permission:${outcome}`);
    return "end_turn";
  }
  if ((match = /\bedit-after-cancel (\S+)/.exec(text))) {
    await cancelled;
    const outcome = await requestToolPermission({
      name: "edit_file",
      title: "file_mutation",
      kind: "edit",
      rawInput: { path: match[1], old_string: "a", new_string: "b" },
    });
    update(`edit-permission:${outcome}`);
    return "cancelled";
  }
  if ((match = /\b(bb|foreign)-tool-permission (\S+)/.exec(text))) {
    const name =
      match[1] === "bb" ? bbToolAlias(match[2]) : `mcp_user-tools_${match[2]}`;
    if (name === undefined) {
      update("tool-permission:no-bb-server");
      return "end_turn";
    }
    const outcome = await requestToolPermission({
      name,
      title: name,
      kind: "other",
      rawInput: { question: "fixture?" },
    });
    update(`tool-permission:${outcome}`);
    return "end_turn";
  }
  if (text.includes("skill-notice")) {
    messageChunk("notice-1", FX_SKILL_WARNING);
    messageChunk("reply-1", "o");
    messageChunk("reply-1", "k");
    return "end_turn";
  }
  if (text.includes("context-notice")) {
    messageChunk("notice-1", FX_CONTEXT_NOTICE);
    messageChunk("reply-1", "selected");
    return "end_turn";
  }
  if (text.includes("interjection")) {
    messageChunk("reply-1", "first");
    messageChunk("notice-1", "HTTP 500: upstream unavailable");
    messageChunk("reply-2", "second");
    return "end_turn";
  }
  if (text.includes("max-tokens")) {
    messageChunk("reply-1", "partial");
    return "max_output_tokens";
  }
  if (text.includes("report-env")) {
    update(
      `env:${JSON.stringify({
        grant: process.env.BB_FX_EDIT_ROOTS ?? null,
        electron: process.env.ELECTRON_RUN_AS_NODE ?? null,
      })}`,
    );
    return "end_turn";
  }
  return undefined;
}

async function handle(message) {
  if (!message.method) {
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
    return;
  }
  const reply = (result) => send({ id: message.id, result });
  switch (message.method) {
    case "initialize":
      reply({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { fork: {} },
        },
        authMethods: [],
        agentInfo: { name: "fx-fixture", version: "1" },
      });
      break;
    case "session/new":
    case "session/load":
    case "session/fork":
      if (process.env.FX_PERMISSION_MODE !== "ask")
        throw new Error("FX_PERMISSION_MODE must be pinned to ask");
      sessionId =
        message.method === "session/load"
          ? message.params.sessionId
          : randomUUID();
      sessionMcpServers = message.params.mcpServers ?? [];
      reply({ sessionId, configOptions: configOptions() });
      break;
    case "session/set_config_option":
      if (message.params.configId === "model") {
        model = message.params.value;
      } else if (
        nativeReasoning &&
        model === "alternate" &&
        message.params.configId === "effort" &&
        ["auto", "low", "medium", "high"].includes(message.params.value)
      ) {
        effort = message.params.value;
      } else {
        throw new Error("Unsupported config option must not be forwarded");
      }
      reply({ configOptions: configOptions() });
      break;
    case "session/prompt": {
      const text = message.params.prompt
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      cancelled = new Promise((resolve) => (cancelPrompt = resolve));
      const stopReason = await approvalScenario(text);
      if (stopReason !== undefined) {
        reply({ stopReason });
        break;
      }
      if (text.includes("refuse")) {
        update("Fixture account rejection");
        reply({ stopReason: "refused" });
        break;
      }
      if (text.includes("request-permission")) {
        const id = randomUUID();
        const result = new Promise((resolve) => pending.set(id, resolve));
        send({
          id,
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: {
              toolCallId: randomUUID(),
              title: "Fixture command",
              kind: "execute",
              status: "pending",
              rawInput: { command: "echo fixture" },
            },
            options: [
              { optionId: "yes", name: "Allow once", kind: "allow_once" },
              { optionId: "no", name: "Deny", kind: "reject_once" },
            ],
          },
        });
        const answer = await result;
        update(
          `permission:${answer.outcome?.optionId ?? answer.outcome?.outcome}`,
        );
      } else if (!text.includes("/noop")) {
        update(
          `model:${model}; effort:${effort}; permission-mode:${process.env.FX_PERMISSION_MODE}`,
        );
      }
      reply({ stopReason: "end_turn" });
      break;
    }
    case "session/cancel":
      cancelPrompt();
      break;
    default:
      if (message.id !== undefined)
        send({
          id: message.id,
          error: { code: -32601, message: "Unknown method" },
        });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  void handle(JSON.parse(line)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
});

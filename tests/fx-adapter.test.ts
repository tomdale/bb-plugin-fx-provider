import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FxAcpAdapter, normalizeFxMessage } from "../src/fx-acp.js";

let root: string;
let workspace: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fx-adapter-")));
  workspace = join(root, "workspace");
  mkdirSync(workspace);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const line = (message: unknown) => JSON.stringify(message);

const bbServer = {
  name: "bb-bridge",
  command: "/usr/bin/node",
  args: ["host.js", "--mcp-stdio"],
  env: [
    { name: "BB_ACP_DYNAMIC_TOOL_TOKEN", value: "secret" },
    {
      name: "BB_ACP_DYNAMIC_TOOLS",
      value: JSON.stringify([{ name: "ask_user_question" }]),
    },
  ],
};

/** An adapter with an fx session in `workspace` and one running prompt. */
function prompting(editRoots: readonly string[] | "no grant" = []) {
  const adapter = new FxAcpAdapter(
    editRoots === "no grant" ? undefined : editRoots,
  );
  adapter.fromBridge(
    line({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: workspace, mcpServers: [bbServer] },
    }),
  );
  adapter.fromBridge(
    line({
      jsonrpc: "2.0",
      id: 7,
      method: "session/prompt",
      params: { sessionId: "s1", prompt: [{ type: "text", text: "hi" }] },
    }),
  );
  return adapter;
}

// Shaped like fx 0.0.10's request for a write inside the workspace.
const permission = (toolCall: Record<string, unknown>, extra = {}) =>
  line({
    jsonrpc: "2.0",
    id: 1,
    method: "session/request_permission",
    params: {
      sessionId: "s1",
      toolCall: { toolCallId: "call_1", status: "pending", ...toolCall },
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        {
          optionId: "allow_always",
          name: "Allow for this session",
          kind: "allow_always",
        },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      ],
      ...extra,
    },
  });
const write = (path: string) =>
  permission({
    name: "write_file",
    title: "file_mutation",
    kind: "edit",
    rawInput: { path, content: "hi\n" },
  });
const allowOnce = line({
  jsonrpc: "2.0",
  id: 1,
  result: { outcome: { outcome: "selected", optionId: "allow_once" } },
});

describe("permission requests", () => {
  it("answers an edit inside the workspace with allow-once itself", () => {
    expect(prompting().fromAgent(write("hello.txt"))).toEqual({
      agent: allowOnce,
    });
  });

  it("answers an edit in an extra write root", () => {
    const extra = join(root, "git");
    expect(prompting([extra]).fromAgent(write(join(extra, "x")))).toEqual({
      agent: allowOnce,
    });
  });

  it.each([
    ["outside the roots", write("/etc/hosts")],
    [
      "for a command",
      permission({
        name: "shell",
        kind: "execute",
        rawInput: { command: "rm -f x" },
      }),
    ],
    [
      "from another session",
      write("hello.txt").replace('"sessionId":"s1"', '"sessionId":"s2"'),
    ],
    [
      "without an allow-once option",
      write("hello.txt").replace(
        '"kind":"allow_once"',
        '"kind":"allow_always"',
      ),
    ],
  ])("forwards an edit %s", (_, request) => {
    expect(prompting().fromAgent(request)).toEqual({ bridge: request });
  });

  it("forwards edits without a grant from the host", () => {
    const request = write("hello.txt");
    expect(prompting("no grant").fromAgent(request)).toEqual({
      bridge: request,
    });
  });

  it("answers BB's own tools in every mode", () => {
    const request = permission({
      name: "mcp_bb-bridge_ask_user_question",
      title: "mcp_bb-bridge_ask_user_question",
      kind: "other",
      rawInput: {},
    });
    expect(prompting("no grant").fromAgent(request)).toEqual({
      agent: allowOnce,
    });
  });

  it("trusts fx's MCP identity over the tool name", () => {
    const adapter = prompting("no grant");
    const announce = (mcp: Record<string, string>) =>
      line({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call_1",
            name: "mcp_bb-bridge_ask_user_question",
            kind: "other",
            _meta: { fx: { toolCall: { internal: false, mcp } } },
          },
        },
      });
    const request = permission({
      name: "mcp_bb-bridge_ask_user_question",
      kind: "other",
    });
    adapter.fromAgent(announce({ server: "user", tool: "ask_user_question" }));
    expect(adapter.fromAgent(request)).toEqual({ bridge: request });
    adapter.fromAgent(
      announce({ server: "bb-bridge", tool: "ask_user_question" }),
    );
    expect(adapter.fromAgent(request)).toEqual({ agent: allowOnce });
  });

  it("leaves requests outside a running prompt to the bridge", () => {
    const adapter = new FxAcpAdapter([]);
    adapter.fromBridge(
      line({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: workspace, mcpServers: [] },
      }),
    );
    const request = write("hello.txt");
    expect(adapter.fromAgent(request)).toEqual({ bridge: request });

    const prompted = prompting();
    prompted.fromAgent(
      line({ jsonrpc: "2.0", id: 7, result: { stopReason: "end_turn" } }),
    );
    expect(prompted.fromAgent(request)).toEqual({ bridge: request });
  });

  it("leaves requests after a cancellation to the bridge until the next prompt", () => {
    const adapter = prompting();
    adapter.fromBridge(
      line({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: "s1" },
      }),
    );
    const request = write("hello.txt");
    expect(adapter.fromAgent(request)).toEqual({ bridge: request });
    adapter.fromAgent(
      line({ jsonrpc: "2.0", id: 7, result: { stopReason: "cancelled" } }),
    );
    adapter.fromBridge(
      line({
        jsonrpc: "2.0",
        id: 8,
        method: "session/prompt",
        params: { sessionId: "s1", prompt: [] },
      }),
    );
    expect(adapter.fromAgent(request)).toEqual({ agent: allowOnce });
  });
});

describe("agent output", () => {
  it("passes updates it does not read through untouched", () => {
    const adapter = prompting();
    for (const output of [
      line({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "c",
            status: "completed",
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: '"sessionUpdate":"agent_message_chunk"',
                },
              },
            ],
          },
        },
      }),
      line({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "m",
            content: { type: "text", text: "hi" },
          },
        },
      }),
      line({
        jsonrpc: "2.0",
        id: 3,
        method: "fs/read_text_file",
        params: { path: "/x" },
      }),
      "not json",
    ]) {
      expect(adapter.fromAgent(output).bridge).toBe(output);
    }
  });

  it("re-sends fx's skill warning as a thought", () => {
    const output = prompting().fromAgent(
      line({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "n",
            content: {
              type: "text",
              text: "skill discovery warning: x; relaunch with FX_TRACE=1 to write a trace log",
            },
          },
        },
      }),
    );
    expect(JSON.parse(output.bridge!).params.update.sessionUpdate).toBe(
      "agent_thought_chunk",
    );
  });

  it.each([
    ["refused", "refusal"],
    ["max_output_tokens", "max_tokens"],
    ["max_model_turns", "max_turn_requests"],
    ["end_turn", "end_turn"],
  ])("reports fx's %s stop reason as ACP %s", (fx, acp) => {
    const output = prompting().fromAgent(
      line({
        jsonrpc: "2.0",
        id: 7,
        result: { stopReason: fx, usage: { inputTokens: 1 } },
      }),
    );
    expect(JSON.parse(output.bridge!)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { stopReason: acp, usage: { inputTokens: 1 } },
    });
  });

  it("still puts the model option first", () => {
    const output = prompting().fromAgent(
      line({
        jsonrpc: "2.0",
        id: 2,
        result: {
          sessionId: "s1",
          configOptions: [{ id: "provider" }, { id: "model" }],
        },
      }),
    );
    expect(JSON.parse(output.bridge!).result.configOptions).toEqual([
      { id: "model" },
      { id: "provider" },
    ]);
  });
});

it("leaves stop reasons in tool payloads alone", () => {
  const value = { params: { rawOutput: { stopReason: "max_output_tokens" } } };
  expect(normalizeFxMessage(value)).toEqual(value);
});

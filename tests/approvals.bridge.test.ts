import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  experimental_resolveProviderBridgeLaunch,
  type BridgeJsonRpcOutputMessage,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fxProviderDeclaration } from "../server.js";

// Approval and transcript behavior of the built adapter, driven through the
// SDK's production bridge bootstrap against the fixture agent.

function launchBridge(cwd: string) {
  const launch = experimental_resolveProviderBridgeLaunch({
    modulePath: fileURLToPath(new URL("../dist/host.js", import.meta.url)),
    pluginId: "fx",
    cwd,
    dataDir: join(cwd, "data"),
  });
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: { ...process.env, ...launch.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: BridgeJsonRpcOutputMessage[] = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-8000);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => messages.push(JSON.parse(line)));
  const send = (message: unknown) =>
    child.stdin.write(`${JSON.stringify(message)}\n`);
  async function waitFor(
    predicate: (message: BridgeJsonRpcOutputMessage) => boolean,
  ) {
    for (let i = 0; i < 500; i++) {
      const found = messages.find(predicate);
      if (found) return found;
      if (child.exitCode !== null) throw new Error(`Bridge exited: ${stderr}`);
      await delay(10);
    }
    throw new Error(`Bridge timed out: ${stderr}\n${JSON.stringify(messages)}`);
  }
  let serial = 0;
  return {
    messages,
    send,
    waitFor,
    async request(method: string, params: unknown) {
      const id = ++serial;
      send({ jsonrpc: "2.0", id, method, params });
      const response = await waitFor((message) => message.id === id);
      expect(response.error, JSON.stringify(response.error)).toBeUndefined();
      return response.result as Record<string, unknown>;
    },
    async close() {
      lines.close();
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

type Bridge = ReturnType<typeof launchBridge>;

let root: string;
let cwd: string;
let extraRoot: string;
let outside: string;
let bridge: Bridge;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fx-approvals-"));
  cwd = join(root, "workspace");
  extraRoot = join(root, "git-common-dir");
  outside = join(root, "outside");
  for (const dir of [cwd, extraRoot, outside]) mkdirSync(dir);
  bridge = launchBridge(cwd);
});
afterEach(async () => {
  await bridge.close();
  rmSync(root, { recursive: true, force: true });
});

const declared = fxProviderDeclaration.experimental_bridgeOptions!;

function options({
  full = false,
  roots = [extraRoot],
}: { full?: boolean; roots?: string[] } = {}) {
  return {
    ...(full
      ? {
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
        }
      : {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
        }),
    model: "alternate",
    // BB always passes the thread's provider environment.
    envVars: { BB_THREAD_ID: "fx-approvals" },
    providerOptions: {
      ...declared,
      acpLaunchSpec: {
        ...(declared.acpLaunchSpec as Record<string, unknown>),
        command: process.execPath,
        args: [
          fileURLToPath(new URL("./fixtures/fx-acp.mjs", import.meta.url)),
        ],
      },
      additionalWorkspaceWriteRoots: roots,
    },
  };
}

const askUserQuestion = {
  name: "ask_user_question",
  description: "Ask the user a question.",
  inputSchema: { type: "object", properties: {} },
};

async function startThread(
  execution: ReturnType<typeof options>,
  dynamicTools?: unknown[],
) {
  await bridge.request("initialize", {
    client: { name: "fx-test", version: "1" },
    protocolVersion: 2,
    grammarVersions: [3, 3],
  });
  const started = await bridge.request("thread/start", {
    threadId: "fx-approvals",
    cwd,
    instructionMode: "append",
    options: execution,
    ...(dynamicTools ? { dynamicTools } : {}),
  });
  return started.providerThreadId as string;
}

let turns = 0;
/** Runs one turn, answering at most one approval with `decision`. */
async function turn(
  providerThreadId: string,
  text: string,
  execution: ReturnType<typeof options>,
  decision: "deny" | "allow_once" = "deny",
) {
  const before = bridge.messages.length;
  const boundaries = () =>
    bridge.messages.filter(
      (message) =>
        message.method === "thread/delta" &&
        JSON.stringify(message.params).includes('"kind":"turn.boundary"'),
    ).length;
  const settled = boundaries();
  turns += 1;
  await bridge.request("turn/start", {
    threadId: "fx-approvals",
    providerThreadId,
    clientRequestId: `creq_abcdefghj${"kmnpqrstuv"[turns % 10]}`,
    options: execution,
    input: [{ type: "text", text, mentions: [] }],
  });
  for (let i = 0; i < 500 && boundaries() === settled; i++) {
    const approval = bridge.messages
      .slice(before)
      .find(
        (message) =>
          message.method === "interaction/request" &&
          !(message as { answered?: boolean }).answered,
      );
    if (approval) {
      (approval as { answered?: boolean }).answered = true;
      bridge.send({
        jsonrpc: "2.0",
        id: approval.id,
        result: { decision, grantedPermissions: null },
      });
    }
    await delay(10);
  }
  const produced = bridge.messages.slice(before);
  return {
    approvals: produced.filter(
      (message) => message.method === "interaction/request",
    ),
    output: JSON.stringify(produced),
    text(channel: "agentMessage" | "reasoningText") {
      return produced
        .filter((message) => message.method === "thread/delta")
        .flatMap(
          (message) =>
            (message.params as { deltas: Record<string, unknown>[] }).deltas,
        )
        .filter(
          (delta) =>
            delta.kind === "item.textDelta" && delta.channel === channel,
        )
        .map((delta) => delta.text)
        .join("");
    },
  };
}

describe("accept-edits", () => {
  it.each([
    ["an absolute path in the workspace", () => join(cwd, "inside.txt")],
    ["a relative path in the workspace", () => "nested/dir/inside.txt"],
    ["an additional write root", () => join(extraRoot, "HEAD.lock")],
  ])("approves an fx edit at %s without asking", async (_, target) => {
    const execution = options();
    const thread = await startThread(execution);
    const result = await turn(thread, `edit-permission ${target()}`, execution);
    expect(result.approvals).toEqual([]);
    expect(result.output).toContain("edit-permission:allow_once");
  });

  it.each([
    ["outside the write roots", () => join(outside, "x.txt")],
    ["through a parent segment", () => "../outside/x.txt"],
    ["through a symlink out of the workspace", () => "escape/x.txt"],
  ])("asks before an fx edit %s", async (_, target) => {
    symlinkSync(outside, join(cwd, "escape"));
    const execution = options();
    const thread = await startThread(execution);
    const result = await turn(thread, `edit-permission ${target()}`, execution);
    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0]?.params).toMatchObject({
      payload: { kind: "approval" },
    });
    expect(result.output).toContain("edit-permission:reject_once");
  });

  it("still asks before commands", async () => {
    const execution = options();
    const thread = await startThread(execution);
    const result = await turn(thread, "request-permission", execution);
    expect(result.approvals).toHaveLength(1);
    expect(result.output).toContain("permission:no");
  });

  it("applies each turn's write roots", async () => {
    const first = options({ roots: [] });
    const thread = await startThread(first);
    const target = join(extraRoot, "x.txt");
    const asked = await turn(thread, `edit-permission ${target}`, first);
    expect(asked.approvals).toHaveLength(1);
    // A different grant changes the agent environment, so the bridge
    // rebuilds the session before the turn and the new adapter applies it.
    const second = options({ roots: [extraRoot] });
    const approved = await turn(thread, `edit-permission ${target}`, second);
    expect(approved.approvals).toEqual([]);
    expect(approved.output).toContain("edit-permission:allow_once");
  });

  it("leaves a request raised after cancellation to the bridge", async () => {
    const execution = options();
    const thread = await startThread(execution);
    await bridge.request("turn/start", {
      threadId: "fx-approvals",
      providerThreadId: thread,
      clientRequestId: "creq_abcdefghjk",
      options: execution,
      input: [
        {
          type: "text",
          text: `edit-after-cancel ${join(cwd, "x.txt")}`,
          mentions: [],
        },
      ],
    });
    // A steer cancels the running prompt before fx asks.
    await bridge.request("turn/steer", {
      threadId: "fx-approvals",
      providerThreadId: thread,
      expectedTurnId: "turn",
      clientRequestId: "creq_abcdefghjm",
      options: execution,
      input: [{ type: "text", text: "/noop", mentions: [] }],
    });
    await bridge.waitFor((message) =>
      JSON.stringify(message).includes("edit-permission:"),
    );
    const output = JSON.stringify(bridge.messages);
    expect(output).toContain("edit-permission:cancelled");
    expect(
      bridge.messages.filter(
        (message) => message.method === "interaction/request",
      ),
    ).toEqual([]);
  });
});

describe("full access", () => {
  it.each([
    ["inside", () => join(cwd, "inside.txt")],
    ["outside", () => join(outside, "x.txt")],
  ])("allows an fx edit %s the workspace without asking", async (_, target) => {
    const execution = options({ full: true });
    const thread = await startThread(execution);
    const result = await turn(thread, `edit-permission ${target()}`, execution);
    expect(result.approvals).toEqual([]);
    expect(result.output).toContain("edit-permission:allow_once");
  });
});

describe("BB's own tools", () => {
  it.each([false, true])(
    "never ask for approval (full access: %s)",
    async (full) => {
      const execution = options({ full });
      const thread = await startThread(execution, [askUserQuestion]);
      const result = await turn(
        thread,
        "bb-tool-permission ask_user_question",
        execution,
      );
      expect(result.approvals).toEqual([]);
      expect(result.output).toContain("tool-permission:allow_once");
    },
  );

  it("are told apart from another server's tool of the same name", async () => {
    const execution = options();
    const thread = await startThread(execution, [askUserQuestion]);
    const result = await turn(
      thread,
      "foreign-tool-permission ask_user_question",
      execution,
    );
    expect(result.approvals).toHaveLength(1);
    expect(result.output).toContain("tool-permission:reject_once");
  });
});

describe("transcript", () => {
  it("keeps fx's skill discovery warning out of the reply", async () => {
    const execution = options();
    const thread = await startThread(execution);
    const result = await turn(thread, "skill-notice", execution);
    expect(result.text("agentMessage")).toBe("ok");
    expect(result.text("reasoningText")).toMatch(
      /^skill discovery warning: .*write a trace log$/,
    );
  });

  it("keeps fx's context-budget notices out of the reply", async () => {
    const execution = options();
    const thread = await startThread(execution);
    const result = await turn(thread, "context-notice", execution);
    expect(result.text("agentMessage")).toBe("selected");
    expect(result.text("reasoningText")).toMatch(
      /^\[context\] MCP description/,
    );
  });

  it("separates other fx messages from the reply without hiding them", async () => {
    const execution = options();
    const thread = await startThread(execution);
    const result = await turn(thread, "interjection", execution);
    expect(result.text("agentMessage")).toBe(
      "first\n\nHTTP 500: upstream unavailable\n\nsecond",
    );
  });

  it("reports fx's output limit as the ACP stop reason", async () => {
    const execution = options();
    const thread = await startThread(execution);
    const result = await turn(thread, "max-tokens", execution);
    expect(result.output).toContain("Agent stopped the turn: max_tokens");
    expect(result.output).not.toContain('"kind":"provider.error"');
  });

  it("keeps the adapter's own environment away from fx", async () => {
    const execution = options();
    const thread = await startThread(execution);
    const result = await turn(thread, "report-env", execution);
    expect(result.output).toContain(
      'env:{\\"grant\\":null,\\"electron\\":null}',
    );
  });
});

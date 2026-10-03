// The bb desktop app runs provider bridges on its Electron executable in Node
// mode (ELECTRON_RUN_AS_NODE=1), so the bridge's process.execPath is Electron.
// host.ts re-runs that executable for the fx ACP adapter and the ACP model
// probe. These tests launch the built dist/host.js through the SDK's
// production bootstrap on a bb Electron executable, against the deterministic
// ACP fixture, and fail if any process in the bridge tree starts Electron
// without Node mode. They skip when no bb Electron executable is installed.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  experimental_resolveProviderBridgeLaunch,
  type BridgeJsonRpcOutputMessage,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fxProviderDeclaration } from "../server.js";

const DEFAULT_ELECTRON_BINARIES = [
  "/Applications/bb.app/Contents/MacOS/bb",
  "/Applications/bb Personal.app/Contents/MacOS/bb Personal",
];

/** BB_ELECTRON_BINARY, else the first installed bb desktop app. */
function electronBinary(): string | undefined {
  const configured = process.env.BB_ELECTRON_BINARY;
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(`BB_ELECTRON_BINARY does not exist: ${configured}`);
    }
    return configured;
  }
  return DEFAULT_ELECTRON_BINARIES.find((path) => existsSync(path));
}

const electron = electronBinary();
const guard = new URL("./fixtures/electron-node-guard.mjs", import.meta.url);
const fixture = fileURLToPath(new URL("./fixtures/fx-acp.mjs", import.meta.url));

function launchElectronBridge(cwd: string, guardLog: string) {
  const launch = experimental_resolveProviderBridgeLaunch({
    modulePath: fileURLToPath(new URL("../dist/host.js", import.meta.url)),
    pluginId: "fx",
    cwd,
    dataDir: join(cwd, "data"),
    nodeArgs: [`--import=${guard.href}`],
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...launch.env,
    ELECTRON_RUN_AS_NODE: "1",
    FX_TEST_ELECTRON_GUARD_LOG: guardLog,
  };
  // The guard owns NODE_OPTIONS inside the bridge tree.
  delete env.NODE_OPTIONS;
  const child = spawn(electron!, launch.args, {
    cwd: launch.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: BridgeJsonRpcOutputMessage[] = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-8000);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => messages.push(JSON.parse(line)));
  let serial = 0;
  async function waitFor(
    predicate: (message: BridgeJsonRpcOutputMessage) => boolean,
    timeoutMs = 15_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = messages.find(predicate);
      if (found) return found;
      if (child.exitCode !== null) throw new Error(`Bridge exited: ${stderr}`);
      await delay(10);
    }
    throw new Error(
      `Bridge timed out: ${stderr}\n${JSON.stringify(messages).slice(-8000)}`,
    );
  }
  return {
    messages,
    stderr: () => stderr,
    waitFor,
    async request(method: string, params: unknown) {
      const id = ++serial;
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
      const response = await waitFor(
        (message) => message.id === id && !message.method,
      );
      expect(
        response.error,
        `${method}: ${JSON.stringify(response.error)}\n${stderr}`,
      ).toBeUndefined();
      return response.result;
    },
    async close() {
      lines.close();
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

describe.skipIf(electron === undefined)(
  `bridge on the bb desktop Electron runtime (${electron ?? "not installed"})`,
  () => {
    let cwd: string;
    let guardLog: string;
    let bridge: ReturnType<typeof launchElectronBridge>;
    // The fixture agent itself runs on Node; only the bridge tree runs on
    // Electron, exactly as in the desktop app where `fx` is a native binary.
    let providerOptions: Record<string, unknown>;

    beforeEach(() => {
      cwd = mkdtempSync(join(tmpdir(), "fx-electron-test-"));
      guardLog = join(cwd, "electron-guard.log");
      const declared = fxProviderDeclaration.experimental_bridgeOptions!;
      providerOptions = {
        ...declared,
        acpLaunchSpec: {
          ...(declared.acpLaunchSpec as Record<string, unknown>),
          command: process.execPath,
          args: [fixture],
        },
      };
      bridge = launchElectronBridge(cwd, guardLog);
    });

    afterEach(async () => {
      await bridge.close();
      rmSync(cwd, { recursive: true, force: true });
    });

    /** Launches the guard replaced with a Node process that exited at once. */
    function blockedElectronLaunches(): string[] {
      return existsSync(guardLog)
        ? readFileSync(guardLog, "utf8").trim().split("\n")
        : [];
    }

    it("discovers the agent's models instead of the Agent default stand-in", async () => {
      const result = (await bridge.request("model/list", {
        cwd,
        providerOptions,
      })) as { models: { id: string; isDefault?: boolean }[] };
      const ids = result.models.map((model) => model.id);
      expect(ids).not.toContain("acp-default");
      expect(blockedElectronLaunches()).toEqual([]);
      expect(result.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "account-default", isDefault: true }),
          expect.objectContaining({ id: "alternate" }),
        ]),
      );
    }, 30_000);

    it("starts a thread and completes a turn", async () => {
      const options = {
        permissionMode: "accept-edits",
        permissionScope: "workspace",
        approvalReviewer: "user",
        permissionEscalation: "ask",
        model: "alternate",
        providerOptions,
      };
      await bridge.request("initialize", {
        client: { name: "fx-electron-test", version: "1" },
        protocolVersion: 2,
        grammarVersions: [3, 3],
      });
      const started = (await bridge.request("thread/start", {
        threadId: "fx-electron",
        cwd,
        instructionMode: "append",
        options,
      })) as { providerThreadId: string };
      expect(started.providerThreadId).toEqual(expect.any(String));
      await bridge.request("turn/start", {
        threadId: "fx-electron",
        providerThreadId: started.providerThreadId,
        clientRequestId: "creq_abcdefghjk",
        options,
        input: [{ type: "text", text: "report settings", mentions: [] }],
      });
      await bridge.waitFor(
        (message) =>
          message.method === "thread/delta" &&
          JSON.stringify(message.params).includes('"kind":"turn.boundary"'),
      );
      expect(blockedElectronLaunches()).toEqual([]);
      const output = JSON.stringify(bridge.messages);
      expect(output).toContain('"status":"completed"');
      expect(output).toContain("model:alternate");
      expect(output).toContain("permission-mode:ask");
      expect(output).not.toContain('"kind":"provider.error"');
    }, 30_000);
  },
);

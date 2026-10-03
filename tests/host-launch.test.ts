import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fxProviderDeclaration } from "../server.js";

// host.ts hands every session request to the shared ACP bridge with a launch
// spec rewritten to run fx behind the adapter. These tests read the rewritten
// spec on every platform; the Electron-runtime suite proves the same contract
// end to end where a bb desktop app is installed.
const forwarded: string[] = [];
vi.mock("@get-bb/plugin-sdk/provider-bridge/acp", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@get-bb/plugin-sdk/provider-bridge/acp")
    >();
  return {
    ...actual,
    experimental_acpProviderBridge: {
      ...actual.experimental_acpProviderBridge,
      handleLine: (line: string) => forwarded.push(line),
    },
  };
});

const hostPath = fileURLToPath(new URL("../host.ts", import.meta.url));
const declared = fxProviderDeclaration.experimental_bridgeOptions!;

function threadStart(
  permissionMode: string,
  envVars?: Record<string, string>,
) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "thread/start",
    params: {
      threadId: "fx-launch",
      cwd: "/work",
      instructionMode: "append",
      options: {
        permissionMode,
        model: "openai/gpt-5.4-mini",
        ...(envVars ? { envVars } : {}),
        providerOptions: {
          ...declared,
          additionalWorkspaceWriteRoots: ["/work-extra"],
        },
      },
    },
  });
}

function forwardedOptions() {
  return JSON.parse(forwarded.at(-1)!).params.options;
}

function rewrittenSpec() {
  return forwardedOptions().providerOptions.acpLaunchSpec;
}

describe("host launch-spec rewrite", () => {
  let electronRunAsNode: string | undefined;
  beforeEach(() => {
    forwarded.length = 0;
    electronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  });
  afterEach(() => {
    if (electronRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = electronRunAsNode;
  });

  it("runs fx behind the adapter with the plugin's launch policy", async () => {
    delete process.env.ELECTRON_RUN_AS_NODE;
    const { experimental_providerBridge } = await import("../host.js");
    experimental_providerBridge.handleLine(threadStart("accept-edits"));
    const spec = rewrittenSpec();
    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toEqual([hostPath, "--fx-acp-adapter", "fx", "acp"]);
    expect(spec.env).toMatchObject({
      FX_PERMISSION_MODE: "ask",
      BB_FX_EDIT_ROOTS: JSON.stringify(["/work-extra"]),
    });
    expect(spec.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
  });

  // The desktop daemon runs bridges on Electron in Node mode, and the shared
  // bridge strips ELECTRON_RUN_AS_NODE from agent environments; without it the
  // adapter re-exec would start the desktop app instead of Node.
  it("forwards ELECTRON_RUN_AS_NODE to the adapter", async () => {
    process.env.ELECTRON_RUN_AS_NODE = "1";
    const { experimental_providerBridge } = await import("../host.js");
    experimental_providerBridge.handleLine(threadStart("full"));
    expect(rewrittenSpec().env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1" });
  });

  // The shared bridge lays BB's thread environment over the launch spec's, so
  // a value from the user's shell or another plugin would otherwise win.
  it("keeps BB's thread environment from overriding the plugin's policy", async () => {
    const { experimental_providerBridge } = await import("../host.js");
    experimental_providerBridge.handleLine(
      threadStart("accept-edits", {
        FX_PERMISSION_MODE: "yolo",
        BB_FX_EDIT_ROOTS: '["/"]',
        BB_THREAD_ID: "fx-launch",
      }),
    );
    expect(forwardedOptions().envVars).toEqual({ BB_THREAD_ID: "fx-launch" });
    expect(rewrittenSpec().env).toMatchObject({
      FX_PERMISSION_MODE: "ask",
      BB_FX_EDIT_ROOTS: JSON.stringify(["/work-extra"]),
    });
  });
});

// Model discovery through the built bridge (dist/host.js, launched by the
// SDK's production bootstrap) against tests/fixtures/fake-fx.mjs and a local
// stand-in for the Gateway catalog, wired through fx's FX_GATEWAY_BASE_URL.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  experimental_resolveProviderBridgeLaunch,
  type BridgeJsonRpcOutputMessage,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { fxProviderDeclaration } from "../server.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const fakeFx = fileURLToPath(
  new URL("./fixtures/fake-fx.mjs", import.meta.url),
);
const SIGN_IN_HELP =
  "fx needs access to Vercel AI Gateway. Run fx login to sign in, fx setup to use an API key, or set AI_GATEWAY_API_KEY.";

const gateway = {
  url: "",
  requests: 0,
  status: 200,
  body: fixture("gateway-models.json"),
};
const server = createServer((request, response) => {
  if (request.url !== "/v1/models") {
    response.writeHead(404).end();
    return;
  }
  gateway.requests++;
  response.writeHead(gateway.status, { "content-type": "application/json" });
  response.end(gateway.status === 200 ? gateway.body : "{}");
});
beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  gateway.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

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
  createInterface({ input: child.stdout }).on("line", (line) => {
    messages.push(JSON.parse(line));
  });
  let serial = 0;
  async function waitFor(
    predicate: (message: BridgeJsonRpcOutputMessage) => boolean,
  ) {
    for (let i = 0; i < 1000; i++) {
      const found = messages.find(predicate);
      if (found) return found;
      if (child.exitCode !== null) throw new Error(`Bridge exited: ${stderr}`);
      await delay(10);
    }
    throw new Error(
      `Bridge timed out: ${stderr}\n${JSON.stringify(messages).slice(-4000)}`,
    );
  }
  return {
    pid: child.pid!,
    get stderr() {
      return stderr;
    },
    signal: (signal: "SIGTERM") => child.kill(signal),
    endInput: () => child.stdin.end(),
    waitFor,
    send(method: string, params: unknown) {
      const id = ++serial;
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
      return waitFor((message) => message.id === id && !message.method);
    },
    async request(method: string, params: unknown): Promise<any> {
      const response = await this.send(method, params);
      expect(
        response.error,
        `${method}: ${JSON.stringify(response.error)}`,
      ).toBeUndefined();
      return response.result;
    },
    async close() {
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

let cwd: string;
let logFile: string;
let bridge: ReturnType<typeof launchBridge>;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "fx-discovery-test-"));
  logFile = join(cwd, "fake-fx.log");
  gateway.requests = 0;
  gateway.status = 200;
  gateway.body = fixture("gateway-models.json");
  bridge = launchBridge(cwd);
});
afterEach(async () => {
  await bridge.close();
  rmSync(cwd, { recursive: true, force: true });
});

/** The declared launch with fx swapped for the fake and its scenario env. */
function providerOptions(
  env: Record<string, string> = {},
  command = process.execPath,
) {
  const declared = fxProviderDeclaration.experimental_bridgeOptions!;
  const spec = declared.acpLaunchSpec as { env: Record<string, string> };
  return {
    ...declared,
    acpLaunchSpec: {
      ...spec,
      command,
      args: [fakeFx, "acp"],
      env: {
        ...spec.env,
        FX_GATEWAY_BASE_URL: gateway.url,
        FAKE_FX_LOG: logFile,
        FAKE_FX_MODELS: fixture("fx-models.json"),
        FAKE_FX_STATUS: fixture("fx-status.json"),
        ...env,
      },
    },
  };
}

function fxLog(): {
  pid: number;
  args?: string[];
  event?: string;
  effort?: string;
}[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
const invocations = () =>
  fxLog().flatMap((entry) => (entry.args ? [entry.args] : []));

describe("Vercel AI Gateway accounts", () => {
  it("lists models from the fx CLI and the Gateway catalog without an fx session", async () => {
    const result = await bridge.request("model/list", {
      cwd,
      providerOptions: providerOptions(),
    });

    expect(result.models[0]).toEqual({
      id: "deepseek/deepseek-v4.1-flash",
      model: "deepseek/deepseek-v4.1-flash",
      displayName: "DeepSeek V4.1 Flash",
      routeProviderId: "deepseek",
      description: "1M context · reasoning, vision",
      supportedReasoningEfforts: [
        { reasoningEffort: "none", description: "No extended thinking" },
        { reasoningEffort: "low", description: "Low reasoning effort" },
        { reasoningEffort: "high", description: "High reasoning effort" },
        { reasoningEffort: "max", description: "Maximum reasoning effort" },
      ],
      defaultReasoningEffort: "high",
      isDefault: true,
    });
    expect(result.models).toHaveLength(17);
    expect(result.models.slice(1).every((model: any) => !model.isDefault)).toBe(
      true,
    );
    expect(result.selectedOnlyModels.map((model: any) => model.id)).toEqual(
      expect.arrayContaining([
        "anthropic/claude-opus-5.5-fast",
        "acme/team-private-model",
      ]),
    );
    // fx ran only its two JSON queries; no agent, so no persisted session.
    expect(invocations().sort()).toEqual([
      ["models", "--json"],
      ["status", "--json"],
    ]);
    expect(gateway.requests).toBe(1);

    // A later refresh asks fx again but reuses the cached catalog.
    await bridge.request("model/list", {
      cwd,
      providerOptions: providerOptions(),
    });
    expect(invocations()).toHaveLength(4);
    expect(gateway.requests).toBe(1);
  });

  it("applies every listed effort to fx when a thread starts", async () => {
    const efforts = ["none", "minimal", "medium", "high", "xhigh", "max"];
    gateway.body = JSON.stringify({
      data: [
        {
          id: "acme/thinker",
          type: "language",
          name: "Acme Thinker",
          owned_by: "acme",
          tags: ["tool-use", "reasoning"],
          reasoning_options: [
            { type: "toggle" },
            { type: "effort", values: efforts },
          ],
        },
      ],
    });
    const options = providerOptions({
      FAKE_FX_MODELS: JSON.stringify({ kind: "models", ids: ["acme/thinker"] }),
      FAKE_FX_STATUS: JSON.stringify({
        kind: "status",
        model: "acme/thinker",
        auth: "fx login",
      }),
      FAKE_FX_ACP: JSON.stringify([{ id: "acme/thinker", efforts }]),
    });
    const catalog = await bridge.request("model/list", {
      cwd,
      providerOptions: options,
    });
    const levels = catalog.models[0].supportedReasoningEfforts.map(
      (effort: any) => effort.reasoningEffort,
    );
    expect(levels).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);

    const fxValue: Record<string, string> = {};
    for (const level of levels) {
      const threadId = `fx-effort-${level}`;
      const execution = {
        permissionMode: "accept-edits",
        permissionScope: "workspace",
        approvalReviewer: "user",
        permissionEscalation: "ask",
        model: "acme/thinker",
        reasoningLevel: level,
        providerOptions: options,
      };
      const started = await bridge.request("thread/start", {
        threadId,
        cwd,
        instructionMode: "append",
        options: execution,
      });
      await bridge.request("turn/start", {
        threadId,
        providerThreadId: started.providerThreadId,
        clientRequestId: "creq_abcdefghjk",
        options: execution,
        input: [{ type: "text", text: "report", mentions: [] }],
      });
      await bridge.waitFor(
        (message) =>
          message.method === "thread/delta" &&
          JSON.stringify(message.params).includes(threadId) &&
          JSON.stringify(message.params).includes('"kind":"turn.boundary"'),
      );
      fxValue[level] = fxLog()
        .filter((entry) => entry.event === "effort")
        .at(-1)!.effort!;
    }
    expect(fxValue).toEqual({
      none: "none",
      low: "minimal",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });
  }, 30_000);

  const signInCases: {
    name: string;
    env: Record<string, string>;
    message: string;
  }[] = [
    {
      name: "fx has no credential",
      env: {
        FAKE_FX_STATUS: JSON.stringify({
          kind: "status",
          model: "moonshotai/kimi-k3",
          auth: "missing",
          auth_refreshable: false,
          auth_help: SIGN_IN_HELP,
        }),
      },
      message: SIGN_IN_HELP,
    },
    {
      name: "its credential expired and cannot refresh",
      env: {
        FAKE_FX_STATUS: JSON.stringify({
          kind: "status",
          model: "moonshotai/kimi-k3",
          auth: "VERCEL_OIDC_TOKEN",
          auth_expired: true,
          auth_refreshable: false,
        }),
      },
      message:
        "Your fx sign-in expired. Run `fx login` on this machine, then reload.",
    },
    {
      name: "the Gateway rejected its credential",
      env: {
        FAKE_FX_MODELS: JSON.stringify({
          kind: "models",
          error: "could not list models: AuthenticationRejected",
          code: "AuthenticationRejected",
        }),
        FAKE_FX_MODELS_EXIT: "1",
      },
      message:
        "fx's credential was rejected while listing models. Run `fx login` on this machine, then reload.",
    },
  ];

  it.each(signInCases)(
    "asks the user to sign in when $name",
    async ({ env, message }) => {
      const response = await bridge.send("model/list", {
        cwd,
        providerOptions: providerOptions(env),
      });
      expect(response.error).toEqual({
        code: -32000,
        message,
        data: { recovery: { kind: "authRequired", message, retryable: false } },
      });
      expect(invocations().some((args) => args[0] === "acp")).toBe(false);
    },
  );

  it("keeps listing models while an expired fx login can refresh itself", async () => {
    const status = {
      ...JSON.parse(fixture("fx-status.json")),
      auth_expired: true,
    };
    const result = await bridge.request("model/list", {
      cwd,
      providerOptions: providerOptions({
        FAKE_FX_STATUS: JSON.stringify(status),
      }),
    });
    expect(result.models[0]).toMatchObject({
      id: status.model,
      isDefault: true,
    });
  });

  it("reports an fx that is not installed as a missing executable", async () => {
    const response = await bridge.send("model/list", {
      cwd,
      providerOptions: providerOptions({}, join(cwd, "not-installed", "fx")),
    });
    expect(response.error).toMatchObject({
      code: -32004,
      message: expect.stringContaining("fx is not installed on this machine"),
    });
  });
});

describe("other fx providers", () => {
  const acpModels = JSON.stringify([
    { id: "gpt-5.5", efforts: ["none", "low", "high", "xhigh"] },
    { id: "gpt-5.4-mini", efforts: ["minimal", "low", "medium", "high"] },
    { id: "plain", efforts: [] },
  ]);

  async function expectProbedCatalog(env: Record<string, string>) {
    const result = await bridge.request("model/list", {
      cwd,
      providerOptions: providerOptions({ FAKE_FX_ACP: acpModels, ...env }),
    });
    expect(result.models).toEqual([
      expect.objectContaining({
        id: "gpt-5.5",
        isDefault: true,
        supportedReasoningEfforts: ["none", "low", "high", "xhigh"].map(
          (reasoningEffort) => expect.objectContaining({ reasoningEffort }),
        ),
        defaultReasoningEffort: "high",
      }),
      expect.objectContaining({
        id: "gpt-5.4-mini",
        defaultReasoningEffort: "medium",
      }),
      expect.objectContaining({
        id: "plain",
        supportedReasoningEfforts: [],
        defaultReasoningEffort: "none",
      }),
    ]);
    expect(invocations()).toContainEqual(["acp"]);
  }

  it("discovers a Codex subscription's models over ACP", async () => {
    await expectProbedCatalog({
      FAKE_FX_STATUS: JSON.stringify({
        kind: "status",
        model: "gpt-5.5",
        model_source: "Codex subscription",
        auth: "Codex subscription",
        auth_refreshable: true,
      }),
      FAKE_FX_MODELS: JSON.stringify({
        kind: "models",
        ids: ["gpt-5.5", "gpt-5.4-mini", "plain"],
        models: [{ id: "gpt-5.5", source: "Codex subscription" }],
      }),
    });
  });

  it("discovers models over ACP when the Gateway catalog does not describe them", async () => {
    await expectProbedCatalog({
      FAKE_FX_MODELS: JSON.stringify({
        kind: "models",
        ids: ["gpt-5.5", "gpt-5.4-mini", "plain"],
      }),
    });
  });

  it("discovers models over ACP while the Gateway catalog is unreachable", async () => {
    gateway.status = 503;
    await expectProbedCatalog({});
  });

  it("discovers models over ACP when fx cannot answer its JSON queries", async () => {
    await expectProbedCatalog({
      FAKE_FX_MODELS: "fx: CodexModelNotSelected",
      FAKE_FX_MODELS_EXIT: "1",
    });
  });
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    // An exited child its parent has not reaped yet is not running.
    return (
      readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z"
    );
  } catch {
    return false;
  }
}

it.each(["EOF", "SIGTERM"] as const)(
  "stops a stalled fx query when the bridge shuts down on %s",
  async (shutdown) => {
    const pending = bridge.send("model/list", {
      cwd,
      providerOptions: providerOptions({ FAKE_FX_STALL: "models" }),
    });
    void pending.catch(() => {});
    await expect
      .poll(() => fxLog().find((entry) => entry.args?.[0] === "models")?.pid, {
        timeout: 5000,
      })
      .toBeDefined();
    const pid = fxLog().find((entry) => entry.args?.[0] === "models")!.pid;
    expect(isRunning(pid)).toBe(true);
    if (shutdown === "EOF") bridge.endInput();
    else bridge.signal(shutdown);
    await expect.poll(() => isRunning(pid), { timeout: 3000 }).toBe(false);
  },
  10_000,
);

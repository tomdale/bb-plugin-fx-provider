import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_JSON_RPC_ERRORS } from "@get-bb/plugin-sdk/provider-bridge";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFxCliRunner,
  fxCliInvocation,
  parseFxJson,
  parseFxModelListing,
  parseFxStatus,
} from "../src/fx-cli.js";
import { BRIDGE_ERROR, MISSING_EXECUTABLE } from "../src/model-discovery.js";

describe("fxCliInvocation", () => {
  it("runs fx subcommands with the agent's command, prefix and environment", () => {
    const invocation = fxCliInvocation(
      {
        command: "/opt/fx/bin/fx",
        args: ["--profile", "work", "acp"],
        env: { FX_X: "1" },
        cwd: "/w",
      },
      ["models", "--json"],
    );
    expect(invocation).toMatchObject({
      command: "/opt/fx/bin/fx",
      args: ["--profile", "work", "models", "--json"],
      cwd: "/w",
    });
    expect(invocation.env.FX_X).toBe("1");
  });

  it("keeps every launch argument when the launch does not end in `acp`", () => {
    expect(
      fxCliInvocation({ command: "node", args: ["fake-fx.mjs"], env: {} }, [
        "status",
        "--json",
      ]).args,
    ).toEqual(["fake-fx.mjs", "status", "--json"]);
  });

  it("keeps the bridge runtime's own variables away from fx", () => {
    const saved = { ...process.env };
    process.env.ELECTRON_RUN_AS_NODE = "1";
    process.env.BB_PROVIDER_BRIDGE_RECORD_DIR = "/tmp/record";
    try {
      const { env } = fxCliInvocation(
        { command: "fx", args: ["acp"], env: {} },
        ["models"],
      );
      expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(env.BB_PROVIDER_BRIDGE_RECORD_DIR).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      process.env = saved;
    }
  });
});

describe("fx JSON output", () => {
  it("finds fx's JSON line after diagnostic output", () => {
    expect(
      parseFxJson('warning: settings\n{"kind":"status","model":"a/b"}\n'),
    ).toEqual({
      kind: "status",
      model: "a/b",
    });
    expect(parseFxJson("fx: CodexModelNotSelected\n")).toBeUndefined();
    expect(parseFxJson("[1,2]")).toBeUndefined();
  });

  it("reads the model listing and notices per-model sources", () => {
    expect(
      parseFxModelListing({
        kind: "models",
        ids: ["a/b", "a/b", 3, "", "c/d"],
      }),
    ).toEqual({ ids: ["a/b", "c/d"], namesSources: false });
    expect(
      parseFxModelListing({
        kind: "models",
        ids: ["gpt-5.5"],
        models: [{ id: "gpt-5.5", source: "Codex subscription" }],
      }),
    ).toEqual({ ids: ["gpt-5.5"], namesSources: true });
    expect(
      parseFxModelListing({
        kind: "models",
        error: "could not list models",
        code: "Unavailable",
      }),
    ).toBeUndefined();
  });

  it("reads the configured model and credential state", () => {
    expect(
      parseFxStatus({
        kind: "status",
        model: "moonshotai/kimi-k3",
        auth: "missing",
        auth_refreshable: false,
        auth_help:
          "fx needs access to Vercel AI Gateway. Run fx login to sign in.",
      }),
    ).toEqual({
      model: "moonshotai/kimi-k3",
      auth: "missing",
      authExpired: false,
      authRefreshable: false,
      authHelp:
        "fx needs access to Vercel AI Gateway. Run fx login to sign in.",
      modelSource: undefined,
    });
    expect(parseFxStatus({ kind: "doctor" })).toBeUndefined();
  });
});

describe("createFxCliRunner", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const node = (script: string) => ({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    env: process.env,
  });
  const isRunning = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("captures what fx printed and how it exited", async () => {
    const runner = createFxCliRunner({ timeoutMs: 5000 });
    expect(
      await runner.run(
        node(
          "console.log('{\"kind\":\"models\"}'); console.error('note'); process.exit(3)",
        ),
      ),
    ).toEqual({
      kind: "exited",
      exitCode: 3,
      stdout: '{"kind":"models"}\n',
      stderr: "note\n",
    });
  });

  it("reports an fx that is not installed", async () => {
    const runner = createFxCliRunner({ timeoutMs: 5000 });
    expect(
      await runner.run({
        ...node(""),
        command: "/nonexistent/fx-for-bb-tests",
      }),
    ).toMatchObject({
      kind: "missing-executable",
      message: expect.stringContaining("ENOENT"),
    });
  });

  it("kills an fx query at its deadline", async () => {
    dir = mkdtempSync(join(tmpdir(), "fx-cli-test-"));
    const pidFile = join(dir, "pid");
    const runner = createFxCliRunner({ timeoutMs: 300 });
    const result = await runner.run(
      node(
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ),
    );
    expect(result).toEqual({ kind: "timed-out", timeoutMs: 300 });
    const pid = Number(readFileSync(pidFile, "utf8"));
    await expect.poll(() => isRunning(pid), { timeout: 2000 }).toBe(false);
  });

  it("kills running fx queries when the bridge closes", async () => {
    dir = mkdtempSync(join(tmpdir(), "fx-cli-test-"));
    const pidFile = join(dir, "pid");
    const runner = createFxCliRunner({ timeoutMs: 60_000 });
    const pending = runner.run(
      node(
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ),
    );
    await expect
      .poll(() => {
        try {
          return Number(readFileSync(pidFile, "utf8")) > 0;
        } catch {
          return false;
        }
      })
      .toBe(true);
    runner.close();
    expect(await pending).toMatchObject({ kind: "exited" });
    await expect
      .poll(() => isRunning(Number(readFileSync(pidFile, "utf8"))), {
        timeout: 2000,
      })
      .toBe(false);
  });
});

it("uses the bridge protocol's error codes", () => {
  expect(BRIDGE_ERROR).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
  expect(MISSING_EXECUTABLE).toBe(BRIDGE_JSON_RPC_ERRORS.MISSING_EXECUTABLE);
});

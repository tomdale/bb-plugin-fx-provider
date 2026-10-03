/**
 * Model discovery over ACP, for fx providers the Gateway catalog does not
 * describe (Codex and Grok subscriptions, configured providers). The shared
 * bridge discovers models by opening an fx session and switching it through
 * every model, so each probe leaves one persisted, empty fx session behind;
 * fx offers no ephemeral discovery session to avoid that.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { defaultReasoningEffort } from "./gateway-catalog.js";

/** The shared bridge's stand-in effort for a model that names none. */
const SYNTHETIC_EFFORT_DESCRIPTION =
  "Reasoning effort is managed by the connected ACP agent.";

/**
 * Correct the catalog the shared bridge discovered over ACP:
 *
 * - Remove its synthetic medium choice, which it gives models that offer no
 *   effort option and models left unprobed at its discovery deadline. A real
 *   medium-only option carries fx's own description and is kept.
 * - Default each model's effort by {@link defaultReasoningEffort}. The bridge
 *   would start at fx's current effort, which fx reports as `auto`; that
 *   names no level, so the bridge would fall back to the lowest one.
 */
export function normalizeProbedModelCatalog(result: unknown): unknown {
  if (result === null || typeof result !== "object") return result;
  const catalog = result as Record<string, unknown>;
  const normalizeModel = (model: Record<string, unknown>) => {
    const listed = model.supportedReasoningEfforts;
    if (!Array.isArray(listed)) return model;
    const efforts =
      listed.length === 1 &&
      listed[0]?.reasoningEffort === "medium" &&
      listed[0]?.description === SYNTHETIC_EFFORT_DESCRIPTION
        ? []
        : listed;
    return {
      ...model,
      supportedReasoningEfforts: efforts,
      defaultReasoningEffort: defaultReasoningEffort(efforts),
    };
  };
  const normalize = (models: unknown) =>
    Array.isArray(models)
      ? models.map((model) =>
          model !== null && typeof model === "object"
            ? normalizeModel(model as Record<string, unknown>)
            : model,
        )
      : models;
  return {
    ...catalog,
    ...(Array.isArray(catalog.models)
      ? { models: normalize(catalog.models) }
      : {}),
    ...(Array.isArray(catalog.selectedOnlyModels)
      ? { selectedOnlyModels: normalize(catalog.selectedOnlyModels) }
      : {}),
  };
}

/**
 * Runs one `model/list` request through the shared bridge in a subprocess of
 * this host artifact (started with `flag`) and writes the normalized answer
 * to stdout. The subprocess owns its stdout, so its answer can be corrected
 * without patching SDK internals or touching the main bridge's session and
 * approval traffic, and its process group (the probe, the ACP adapter and
 * `fx acp`) can be killed whole. Importing the host artifact starts no
 * processes.
 */
export function createAcpModelProbe(modulePath: string, flag: string) {
  const send = (message: unknown) =>
    process.stdout.write(`${JSON.stringify(message)}\n`);
  const cleanups = new Set<() => void>();
  return {
    request(line: string, id: string | number): void {
      const child = spawn(process.execPath, [modulePath, flag], {
        stdio: ["pipe", "pipe", "inherit"],
        // Keep the probe and its ACP descendants in a group for cancellation.
        detached: process.platform !== "win32",
      });
      const lines = createInterface({ input: child.stdout });
      let settled = false;
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        cleanups.delete(cleanup);
        lines.close();
        child.stdin.destroy();
        try {
          if (process.platform !== "win32" && child.pid) {
            process.kill(-child.pid, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          // The probe may already have exited.
        }
      };
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
        cleanup();
      };
      const timer = setTimeout(
        () => fail("fx model discovery timed out"),
        40_000,
      );
      cleanups.add(cleanup);
      child.on("error", (error) =>
        fail(`Cannot start fx model discovery: ${error.message}`),
      );
      child.on("close", () =>
        fail("fx model discovery exited before responding"),
      );
      child.stdin.on("error", (error) =>
        fail(`Cannot request fx models: ${error.message}`),
      );
      lines.on("line", (output) => {
        let response;
        try {
          response = JSON.parse(output);
        } catch {
          fail("fx model discovery returned invalid JSON");
          return;
        }
        if (settled || response?.id !== id || response.method) return;
        settled = true;
        send(
          "result" in response
            ? {
                ...response,
                result: normalizeProbedModelCatalog(response.result),
              }
            : response,
        );
        cleanup();
      });
      child.stdin.write(`${line}\n`);
    },
    close(): void {
      for (const cleanup of cleanups) cleanup();
    },
  };
}

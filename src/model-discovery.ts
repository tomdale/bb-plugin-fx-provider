import {
  experimental_acpLaunchSpecSchema,
  experimental_acpProviderBridge,
} from "@get-bb/plugin-sdk/provider-bridge/acp";
import { createAcpModelProbe } from "./acp-model-probe.js";
import {
  createFxCliRunner,
  fxCliInvocation,
  parseFxJson,
  parseFxModelListing,
  parseFxStatus,
  type FxCliResult,
  type FxLaunch,
  type FxStatus,
} from "./fx-cli.js";
import {
  createGatewayCatalogCache,
  gatewayCatalogUrl,
} from "./gateway-catalog.js";
import { buildModelList, type ModelListResult } from "./model-list.js";

/** Bridge protocol error codes (the SDK's `BRIDGE_JSON_RPC_ERRORS`). */
export const BRIDGE_ERROR = -32000;
/** The host reports this code as `missing_executable`, whatever the message. */
export const MISSING_EXECUTABLE = -32004;

/** `fx models --json` takes about 0.3 s; `fx status --json` far less. */
const FX_QUERY_TIMEOUT_MS = 10_000;

/** The credential sources fx names for providers other than the Gateway. */
const NON_GATEWAY_CREDENTIALS = new Set([
  "Codex subscription",
  "Grok subscription",
  "configured provider",
]);

const SIGN_IN =
  "fx is not signed in. Run `fx login` on this machine, then reload.";
const SIGNED_OUT_BY_EXPIRY =
  "Your fx sign-in expired. Run `fx login` on this machine, then reload.";
const CREDENTIAL_REJECTED =
  "fx's credential was rejected while listing models. Run `fx login` on this machine, then reload.";

type Answer =
  | { kind: "result"; result: ModelListResult }
  | { kind: "error"; error: { code: number; message: string; data?: unknown } }
  | { kind: "probe"; reason: string };

/**
 * Answers `model/list` for the fx provider.
 *
 * For the Vercel AI Gateway, the answer comes from this process without an fx
 * session: `fx models --json` (the ids this account can select),
 * `fx status --json` (the configured model and credential state) and the
 * public Gateway catalog (names, vendors, context windows and the effort
 * options fx derives from it), fetched concurrently. For other fx providers,
 * or when the catalog cannot describe the account's models, the request goes
 * to the ACP model probe instead. Requests the shared bridge would reject go
 * to the shared bridge, so its validation errors stay authoritative.
 */
export function createFxModelDiscovery(modulePath: string, probeFlag: string) {
  const probe = createAcpModelProbe(modulePath, probeFlag);
  const fx = createFxCliRunner({ timeoutMs: FX_QUERY_TIMEOUT_MS });
  let dataDir: string | undefined;
  let closed = false;
  const catalogs = createGatewayCatalogCache({ log, storeDir: () => dataDir });

  async function answer(launch: FxLaunch): Promise<Answer> {
    // The catalog fetch runs beside the fx queries; it is cached either way.
    const lookup = catalogs.get(
      gatewayCatalogUrl({ ...process.env, ...launch.env }),
    );
    const query = (subcommand: string) =>
      fx.run(fxCliInvocation(launch, [subcommand, "--json"]));
    const [models, status] = await Promise.all([
      query("models"),
      query("status"),
    ]);

    for (const [subcommand, result] of [
      ["models", models],
      ["status", status],
    ] as const) {
      if (result.kind === "missing-executable") {
        return failure(
          MISSING_EXECUTABLE,
          `fx is not installed on this machine (${result.message}).`,
        );
      }
      if (result.kind === "failed-to-start") {
        return failure(BRIDGE_ERROR, `Cannot run fx: ${result.message}`);
      }
      if (result.kind === "timed-out") {
        return failure(
          BRIDGE_ERROR,
          `fx did not answer \`fx ${subcommand} --json\` within ${result.timeoutMs / 1000} s.`,
        );
      }
    }

    const fxStatus =
      status.kind === "exited"
        ? parseFxStatus(parseFxJson(status.stdout))
        : undefined;
    const signIn = signInMessage(fxStatus, models);
    if (signIn !== undefined) {
      return failure(BRIDGE_ERROR, signIn, {
        recovery: { kind: "authRequired", message: signIn, retryable: false },
      });
    }
    const listing =
      models.kind === "exited" && models.exitCode === 0
        ? parseFxModelListing(parseFxJson(models.stdout))
        : undefined;
    if (fxStatus === undefined) {
      return probeFor("`fx status --json` printed no status");
    }
    if (listing === undefined) {
      return probeFor("`fx models --json` printed no model list");
    }
    const source =
      fxStatus.modelSource ??
      (NON_GATEWAY_CREDENTIALS.has(fxStatus.auth ?? "")
        ? fxStatus.auth
        : undefined);
    if (source !== undefined || listing.namesSources) {
      return probeFor(
        `fx uses ${source ?? "a provider other than the Gateway"}`,
      );
    }
    if (listing.ids.length === 0 && fxStatus.model === undefined) {
      return probeFor("fx lists no models");
    }
    const catalog = await lookup;
    if (catalog === null) return probeFor("the Gateway catalog is unavailable");
    // A Gateway account lists Gateway ids. A listing the catalog mostly cannot
    // describe comes from another provider, which only the probe can describe.
    const described = listing.ids.filter((id) =>
      catalog.catalog.has(id),
    ).length;
    if (described * 2 < listing.ids.length) {
      return probeFor(
        `the Gateway catalog describes ${described} of fx's ${listing.ids.length} models`,
      );
    }
    if (catalog.stale) log("answering from the last Gateway catalog fetched");
    return {
      kind: "result",
      result: buildModelList({
        ids: listing.ids,
        defaultModel: fxStatus.model,
        catalog: catalog.catalog,
      }),
    };
  }

  return {
    /** The bridge's plugin data directory, which keeps the last catalog. */
    useDataDir(dir: string): void {
      dataDir = dir;
    },
    request(line: string, id: string | number): void {
      if (closed) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        message = undefined;
      }
      if (!isWellFormedModelList(message)) {
        experimental_acpProviderBridge.handleLine(line);
        return;
      }
      const launch = experimental_acpLaunchSpecSchema.safeParse(
        message.params?.providerOptions?.acpLaunchSpec,
      );
      if (!launch.success) {
        // Without a launch spec the shared bridge answers with its stand-in
        // "Agent default" model; the probe normalizes that answer too.
        probe.request(line, id);
        return;
      }
      answer(launch.data).then(
        (outcome) => {
          // A query cut short by shutdown settles too; answer nothing then.
          if (closed) return;
          if (outcome.kind === "probe") {
            log(`using the ACP model probe: ${outcome.reason}`);
            probe.request(line, id);
            return;
          }
          send(
            outcome.kind === "result"
              ? { jsonrpc: "2.0", id, result: outcome.result }
              : { jsonrpc: "2.0", id, error: outcome.error },
          );
        },
        (error: unknown) => {
          if (closed) return;
          const message =
            error instanceof Error ? error.message : String(error);
          send({ jsonrpc: "2.0", id, error: { code: BRIDGE_ERROR, message } });
        },
      );
    },
    close(): void {
      closed = true;
      fx.close();
      probe.close();
    },
  };
}

/**
 * fx needs a sign-in when it has no credential, when its credential expired
 * and cannot refresh itself, or when listing models was refused for
 * authentication. An expired credential that can refresh (an fx login) is
 * refreshed by fx on its next request and needs nothing from the user.
 */
function signInMessage(
  status: FxStatus | undefined,
  models: FxCliResult,
): string | undefined {
  if (status?.auth === "missing") return status.authHelp ?? SIGN_IN;
  if (status?.authExpired && !status.authRefreshable) {
    return status.authHelp ?? SIGNED_OUT_BY_EXPIRY;
  }
  if (
    models.kind === "exited" &&
    models.exitCode !== 0 &&
    `${models.stdout}\n${models.stderr}`.includes("AuthenticationRejected")
  ) {
    return CREDENTIAL_REJECTED;
  }
  return undefined;
}

function failure(code: number, message: string, data?: unknown): Answer {
  return {
    kind: "error",
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function probeFor(reason: string): Answer {
  return { kind: "probe", reason };
}

/** The request shape the shared bridge accepts for `model/list`. */
function isWellFormedModelList(message: unknown): message is {
  params?: { providerOptions?: { acpLaunchSpec?: unknown } };
} {
  if (!isRecord(message) || message.jsonrpc !== "2.0") return false;
  const params = message.params;
  if (params === undefined) return true;
  if (!isRecord(params)) return false;
  if (
    params.cwd !== undefined &&
    (typeof params.cwd !== "string" || params.cwd === "")
  ) {
    return false;
  }
  return (
    params.providerOptions === undefined || isRecord(params.providerOptions)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(message: string): void {
  process.stderr.write(`fx model discovery: ${message}\n`);
}

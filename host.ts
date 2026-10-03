import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createFxModelDiscovery } from "./src/model-discovery.js";
import {
  experimental_acpLaunchSpecSchema,
  experimental_acpProviderBridge,
} from "@get-bb/plugin-sdk/provider-bridge/acp";
import { runFxAcp } from "./src/fx-acp.js";
import { FX_EDIT_ROOTS_ENV, fxEditGrantEnv } from "./src/fx-permissions.js";

const adapterFlag = "--fx-acp-adapter";
const modulePath = fileURLToPath(import.meta.url);
const probeFlag = "--fx-model-probe";
const probeMode =
  process.argv[1] === modulePath && process.argv[2] === probeFlag;
const modelDiscovery = createFxModelDiscovery(modulePath, probeFlag);

/**
 * Launch-spec variables the plugin owns. BB's own environment for a thread
 * (shell, machine settings, other plugins) would otherwise override them:
 * the permission mode that makes fx ask BB, and the adapter's edit grant.
 */
const PLUGIN_OWNED_ENV = ["FX_PERMISSION_MODE", FX_EDIT_ROOTS_ENV];

// BB normally imports this artifact. Only a direct invocation by the shared
// bridge starts the adapter, using the same self-contained artifact on each host.
if (process.argv[1] === modulePath && process.argv[2] === adapterFlag) {
  const command = process.argv[3];
  if (!command) throw new Error("Missing fx ACP command");
  runFxAcp(command, process.argv.slice(4));
}

let closing = false;
function closeBridge(): void {
  if (closing) return;
  closing = true;
  modelDiscovery.close();
  experimental_acpProviderBridge.onClose?.();
}

export const experimental_providerBridge = {
  ...experimental_acpProviderBridge,
  // The bootstrap passes the plugin's data directory, where model discovery
  // keeps the last Gateway catalog across bridge restarts.
  start(context: { dataDir: string }): void {
    modelDiscovery.useDataDir(context.dataDir);
  },
  // The SDK bootstrap only hooks signals declared by the entry. Signals and
  // stdin closure must all release detached fx queries and model probes
  // before the SDK exits.
  onClose: closeBridge,
  onSigterm: closeBridge,
  onSigint: closeBridge,
  handleLine(line: string): void {
    try {
      const message = JSON.parse(line);
      if (
        !probeMode &&
        message.method === "model/list" &&
        (typeof message.id === "string" || typeof message.id === "number")
      ) {
        modelDiscovery.request(line, message.id);
        return;
      }
      // Sessions, and the ACP model probe's own session, run fx behind the
      // adapter (src/fx-acp.ts). Health and installation probes inspect the
      // fx executable itself.
      if (
        [
          "model/list",
          "thread/start",
          "thread/resume",
          "thread/fork",
          "turn/start",
        ].includes(message.method)
      ) {
        const options =
          message.params?.options?.providerOptions ??
          message.params?.providerOptions;
        const spec = experimental_acpLaunchSpecSchema.safeParse(
          options?.acpLaunchSpec,
        );
        if (spec.success) {
          const envVars = message.params?.options?.envVars;
          if (envVars !== null && typeof envVars === "object") {
            for (const name of PLUGIN_OWNED_ENV) delete envVars[name];
          }
          options.acpLaunchSpec = {
            ...spec.data,
            command: process.execPath,
            args: [
              modulePath,
              adapterFlag,
              spec.data.command,
              ...spec.data.args,
            ],
            env: {
              ...spec.data.env,
              ...(process.env.ELECTRON_RUN_AS_NODE && {
                ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE,
              }),
              // Recomputed for every turn: when the grant changes, the agent
              // environment changes and the bridge rebuilds the session.
              ...fxEditGrantEnv(message.params?.options),
            },
          };
          line = JSON.stringify(message);
        }
      }
    } catch {
      // The shared bridge owns invalid JSON and request validation.
    }
    experimental_acpProviderBridge.handleLine(line);
  },
};

// The ACP model probe (model discovery for fx providers other than the
// Gateway) is a short-lived run of this artifact. It uses the same shared
// bridge and ACP adapter; its stdout is isolated so catalog metadata can be
// normalized without patching SDK internals or intercepting the main bridge's
// session/approval traffic.
if (probeMode) {
  createInterface({ input: process.stdin })
    .on("line", (line) => experimental_providerBridge.handleLine(line))
    .on("close", () => experimental_providerBridge.onClose());
}

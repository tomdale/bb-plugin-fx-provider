import type {
  BbPluginApi,
  PluginProviderDeclaration,
} from "@get-bb/plugin-sdk";
import { FX_REASONING_LEVELS } from "./src/gateway-catalog.js";

/**
 * Pin ask mode so fx forwards unresolved permission requests to BB even when
 * the host shell sets a permissive default. fx's own rules, session grants,
 * and tool admission still apply before a request reaches the client.
 */
const FX_ENV = { FX_PERMISSION_MODE: "ask" } as const;

/**
 * How BB launches fx. `fx acp` speaks the Agent Client Protocol, which the
 * SDK's shared ACP bridge already implements end to end, so this plugin
 * declares the launch and lets that bridge do the talking. host.ts normalizes
 * the order of fx's model config options before the shared bridge reads them.
 *
 * No `modelCli`: host.ts answers `model/list` itself, from `fx models --json`,
 * `fx status --json` and the public Gateway catalog, run with this command
 * and environment. The shared bridge's model-list parser reads text lines,
 * not fx's JSON.
 *
 * No `reasoningCli` / `nativeReasoning`: fx offers each model's efforts as an
 * ACP `thought_level` option, which the shared bridge applies directly.
 *
 * No `permissionCli`: fx takes its permission mode from the environment, not
 * from a command-line flag, so the mode is pinned in `env` above.
 */
const FX_LAUNCH_SPEC = {
  displayName: "fx",
  command: "fx",
  args: ["acp"],
  env: FX_ENV,
} as const;

/** The provider BB lists in the picker. Exported for the declaration tests. */
export const fxProviderDeclaration: PluginProviderDeclaration = {
  id: "fx",
  displayName: "fx",
  // Grouped with the other ACP agents, which is what fx is and which bridge
  // runs it.
  family: "acp",
  // BB renders the monochrome SVG as a mask that follows the current theme.
  icon: "./assets/fx.svg",
  strings: {
    signInHint: "Run `fx login` on the machine to sign in.",
    expiredHint: "Your fx session expired. Run `fx login`, then reload.",
    installUrl: "https://fx.sh/",
  },
  experimental_bridgeOptions: {
    acpDialect: "generic",
    acpLaunchSpec: {
      ...FX_LAUNCH_SPEC,
      args: [...FX_LAUNCH_SPEC.args],
      env: { ...FX_ENV },
    },
  },
  // fx answers `model/list` from the signed-in account, not from anything in
  // the workspace, so one probe per machine serves every environment on it.
  models: { scope: "host" },
  // The shared ACP bridge answers the health probe for every agent it runs.
  // fx has no usage or installation reporting over ACP.
  maintenance: { health: true, usage: false, installation: false },
  capabilities: {
    supportsServiceTier: false,
    // fx's native ask-user-question is ACP `elicitation/create`, which the
    // shared bridge does not surface in BB. Claiming otherwise would make BB
    // suppress its own fallback.
    supportsNativeUserQuestion: false,
    // `fx acp` advertises `sessionCapabilities: { list, resume, close }` — no
    // `session/fork`.
    fork: "none",
    supportsManualCompaction: false,
    supportsThreadArchive: false,
    supportsThreadRename: false,
    permissionModes: ["accept-edits", "full"],
    // Every level an fx effort value maps to. BB accepts a thread's level
    // only from this ladder; each model's own subset comes from `model/list`.
    reasoningLevels: [...FX_REASONING_LEVELS],
  },
  reasoningLevels: [
    { id: "none", label: "None" },
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Extra High" },
    { id: "max", label: "Max" },
  ],
  composerActions: [],
};

/** Register the fx provider. Its implementation is the SDK's ACP bridge. */
export default function plugin(bb: BbPluginApi): void {
  bb.providers.register(fxProviderDeclaration);
}

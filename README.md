# bb-plugin-fx

Run [fx](https://fx.sh/) as an agent provider inside BB, with model selection,
resumable sessions, and streamed replies and tool activity.

<img width="600" height="380" alt="fx provider in BB" src="https://github.com/user-attachments/assets/f9eefc64-6604-4ad1-acf9-1be071d2712f" />

## Requirements

- BB 0.44.0 or newer (plugin SDK 0.6.9).
- The fx CLI available as `fx` on each execution host's `PATH`.
- An authenticated fx account on that host: run `fx login`, then `fx status --json`.
- Model access, limits, and service charges depend on your fx account and model provider.

## Install

Install the latest compatible 0.3.x release:

```sh
bb plugin install git:https://github.com/MayankBansal12/bb-plugin-fx-provider.git@^0.3.0
```

Use `@v0.3.0` instead of `@^0.3.0` to pin the exact 0.3.0 release.

For a local checkout:

```sh
npm ci
npm run check
bb plugin install .
```

After local changes, run `npm run build` and `bb plugin reload fx`.
The provider appears as **fx** in BB, grouped with the other ACP agents.
Its SVG mark follows the theme through BB's built-in provider icon rendering.

## How it works

`server.ts` registers the provider through `bb.providers.register` and declares
how to launch `fx acp`. `host.ts` uses the SDK's shared ACP bridge for sessions,
streaming, and approvals. A small child-process adapter puts fx's actual `model` config option
before its `provider` option: fx 0.0.7 marks both as category `model`, while the
shared bridge selects the first. It preserves the options and their values in
responses and updates. The adapter also translates fx's `refused` stop reason
to ACP's `refusal`, retaining the agent's rejection text. The plugin ships no
frontend bundle.

### Models and reasoning effort

`host.ts` answers BB's model-list request itself. For a Vercel AI Gateway
account it runs `fx models --json` (the ids the account can select) and
`fx status --json` (the configured model and sign-in state) with the launch
spec's command and environment, and reads the public Gateway catalog
(`https://ai-gateway.vercel.sh/v1/models`, or fx's loopback
`FX_GATEWAY_BASE_URL`) at the same time. No fx session is created. The catalog
is cached in memory for ten minutes, and its last good copy is reused while the
Gateway is unreachable. BB itself refreshes the list every ten minutes per
machine.

Each model gets its Gateway name, its vendor as the picker's qualifier, a short
description (context window and capabilities), and the efforts fx offers for
it: the values of the first `effort` entry in the model's `reasoning_options`,
read as fx reads them and mapped onto BB's levels (`minimal` becomes Low). A
model starts at Medium when it offers it, else High, else its lowest level that
still reasons. fx's configured model is the default. The bridge applies the
selected model and effort through fx's ACP options; choosing an effort needs
an fx that offers efforts over ACP (0.0.9 or later).

The picker lists the default model first, then the featured models: for each
vendor in `FEATURED_VENDORS` (`src/model-list.ts`), the newest model of each
of its newest families, leaving out fast twins and small, beta, or open-weight
variants. Every other model the account can select is under **More models**.

When fx is not signed in, BB shows fx's own sign-in help; when fx is not
installed, BB reports the CLI as missing. For other fx providers (Codex or Grok
subscriptions, configured providers), or when the catalog cannot describe the
account's models, discovery falls back to the shared bridge's ACP probe, which
opens an fx session and switches it through every model. Each such refresh
leaves one empty fx session behind.

### Permissions

The launch spec pins `FX_PERMISSION_MODE=ask`, overriding an inherited `auto`
or `yolo` mode. The bridge sends fx's `session/request_permission` requests to
BB in `accept-edits` mode and allows them in `full` mode. BB's escalation policy
still applies. This is not a filesystem sandbox: fx's own configured rules,
session grants, and tool admission can decide a call before fx asks BB.

The plugin does not set fx's `mode` session option. It passes model selection
and any advertised reasoning-effort choices through the bridge. The fx CLI
owns credentials and service connections; the plugin stores no credentials of
its own and adds no telemetry.

### Supported scope

The provider supports session restore but does not advertise forks, manual
compaction, provider-side archive/rename, service tiers, or native user-question
UI. A model without effort options offers no reasoning control, and fx keeps
its own effort for it.

Registration uses the supported `bb.providers.register` API. The shared bridge
export and static launch options still use the SDK's published experimental
names; the plugin does not use the removed `bb.agents.experimental_registerProvider`
API or the removed `supportsWorkflows` capability.

## Development and validation

```sh
npm run typecheck
npm test
npm run check:managed
```

`npm run check` runs all three; `npm test` builds the artifacts first.
GitHub Actions runs the same checks on pull requests and pushes to `main`.

- Registration tests load the plugin into the SDK's fake host and validate the
  launch spec with the SDK's ACP schema.
- Bridge tests launch the actual `dist/host.js` through the public production
  bootstrap. A local ACP fixture exercises canonical conformance (including
  restore and streaming), model discovery, and permission allow/deny/full
  behavior, plus fx's refusal response. It also rejects any launch that loses `FX_PERMISSION_MODE=ask`.
  These tests need no account and do not claim to test the real fx CLI.
- Model-discovery tests run the built bridge against a fake fx CLI
  (`tests/fixtures/fake-fx.mjs`) and a local stand-in for the Gateway catalog:
  the Gateway listing, sign-in and missing-CLI errors, the ACP fallback, and
  each listed effort reaching fx when a thread starts. Catalog fixtures are
  real Gateway entries.
- `check:managed` builds a temporary copy with `npm install --omit=dev`, checks
  its server/host artifacts, and imports the host export. This catches missing
  production dependencies that a developer build would conceal.

Keep `@get-bb/plugin-sdk` in **dependencies**, pinned to the tested version.
BB bundles its `provider-bridge/acp` subpath from the plugin's own installation;
managed Git installs omit development dependencies. `zod` is also needed by
that bridge. The general `bb plugin types --check` advice to move the SDK to
devDependencies does not apply to provider bridges.

`PLUGIN_OVERVIEW.md` contains the marketplace description. Publish a new
immutable `vX.Y.Z` tag for each validated release. Update the marketplace range
when a release falls outside it, and keep its overview and category current.

The marketplace icon source is `assets/fx-marketplace.svg`. It has a transparent
background so BB can tint it as an SVG mask. Vendor it into the marketplace
under a filename containing the first eight characters of its SHA-256 hash;
do not add an opaque background to the SVG.

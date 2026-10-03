# bb-plugin-fx

Run [fx](https://fx.sh/) as an agent provider inside BB, with model selection,
resumable sessions, and streamed replies and tool activity.

<img width="600" height="380" alt="fx provider in BB" src="https://github.com/user-attachments/assets/f9eefc64-6604-4ad1-acf9-1be071d2712f" />

## Requirements

- BB 0.44.0 or newer (plugin SDK 0.6.5).
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
streaming, and approvals, and runs fx behind a small child-process adapter that
adjusts fx's ACP traffic before the bridge reads it:

- It puts fx's actual `model` config option before its `provider` option: fx
  marks both as category `model`, while the shared bridge selects the first.
  Options and their values are otherwise preserved.
- It translates fx's stop reasons `refused`, `max_output_tokens`, and
  `max_model_turns` to ACP's `refusal`, `max_tokens`, and `max_turn_requests`,
  retaining the agent's text.
- It answers the permission requests BB's policy already decides (see
  [Permissions](#permissions)).
- It keeps fx's operational text out of the reply. fx sends its notices as
  message text under a message id of their own, and the shared bridge would
  stream them into the reply. fx's context notices (the skill discovery
  warning and `[context]` budget notices) are sent on as reasoning instead,
  and any other text that starts a new message id within the same reply, such
  as an HTTP error or a restart marker, starts a new paragraph.

The plugin ships no frontend bundle.

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
or `yolo` mode, so fx sends a `session/request_permission` request for each
sensitive tool call. The requests are decided as follows:

- **Workspace edits.** The adapter approves fx `write_file` and `edit_file`
  calls whose target lies inside the thread's workspace or BB's additional
  write roots (for a worktree, the git directories its commits write to; BB's
  thread storage). Relative paths resolve against the workspace and symlinks are
  followed, as fx does. BB's permission modes all approve such edits, so the
  adapter approves them in every mode. An edit outside the roots, a path the
  adapter cannot resolve with certainty (`..` segments, `~`, a dangling
  symlink), and edits of any other shape go to the bridge.
- **BB's own tools.** The adapter approves calls to the tools BB serves to fx
  through the bridge's MCP server, in every mode; BB authorizes those itself.
- **Everything else**, including shell commands (fx deletes and moves files
  with commands), goes to the bridge, which allows it in `full` mode and
  otherwise sends it to BB to ask the user, applying BB's escalation policy.

The adapter answers only while a prompt is running and has not been
cancelled, and always with fx's allow-once option, so it creates no fx session
grant. host.ts recomputes the adapter's grant for every turn; a turn whose
policy grants different write roots runs in a rebuilt session.

The shared bridge decides the remaining requests with the permission mode the
session was started with. Switching a running thread between `accept-edits`
and `full` takes effect for commands and other edits only when the session
next starts: after BB releases the idle session (30 minutes) or restarts the
bridge.

This is not a filesystem sandbox: fx's own configured rules, session grants,
and tool admission can decide a call before fx asks BB.

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
  `tests/approvals.bridge.test.ts` drives the same fixture through fx-shaped
  edit, command, and MCP tool permission requests and fx's notices, in
  `accept-edits` and `full` mode. These tests need no account and do not claim
  to test the real fx CLI.
- Model-discovery tests run the built bridge against a fake fx CLI
  (`tests/fixtures/fake-fx.mjs`) and a local stand-in for the Gateway catalog:
  the Gateway listing, sign-in and missing-CLI errors, the ACP fallback, and
  each listed effort reaching fx when a thread starts. Catalog fixtures are
  real Gateway entries.
- Electron runtime tests (`tests/electron-runtime.bridge.test.ts`) run the
  built bridge the way the desktop app does: on a bb desktop executable in
  Node mode (`ELECTRON_RUN_AS_NODE=1`), where `process.execPath` is Electron
  and the host re-runs it for the ACP adapter and the model probe. They check
  model discovery and a complete turn against the fixture. A guard loaded
  into every process of the bridge tree turns any Electron launch without
  Node mode into an immediate exit, so a regression fails the test instead
  of opening the app. The executable is `BB_ELECTRON_BINARY`, else
  `/Applications/bb.app` or `/Applications/bb Personal.app`; without one the
  tests skip (as on the Linux CI runner).
- `check:managed` builds a temporary copy with `npm install --omit=dev`, checks
  its server/host artifacts, and imports the host export. This catches missing
  production dependencies that a developer build would conceal.

### Manual QA in an isolated bb

`scripts/qa/isolated-bb.sh` runs a private bb server on an installed desktop
app's runtime with its own data directory and ports, so the plugin can be
installed and exercised with real fx threads without touching the bb you use
day to day. The app must host the plugin SDK version that `package.json`
requires; `start` prints the version it found.

```sh
npm run build
BB_APP=/Applications/bb.app SERVER_PORT=41886 scripts/qa/isolated-bb.sh start
source "${TMPDIR:-/tmp}/bb-plugin-fx-qa/env.sh"
bb status                      # Data dir must be the QA directory
bb plugin install . --yes      # after rebuilding: bb plugin reload fx
bb provider models fx
bb project create --name fx-qa --root <scratch git repo> --json
bb thread spawn --project <id> --new-environment worktree --provider fx \
  --model openai/gpt-5.4-mini --permission-mode accept-edits \
  --prompt "Reply with exactly: ok" --json
bb thread wait <thread> --timeout 120 && bb thread log <thread>
bb thread interactions list <thread>
scripts/qa/isolated-bb.sh stop
```

Run every `bb` command in the shell that sourced `env.sh`. Threads that
share an unmanaged workspace run one at a time, so use
`--new-environment worktree` for concurrent threads. Real fx threads are
billed to the signed-in fx account; keep prompts small.

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

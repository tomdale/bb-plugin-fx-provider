Choose fx in BB's provider picker to work with its coding agent in your threads. Follow streamed replies and tool activity, select models available to your fx account, and resume previous sessions.

## What you get

- An fx provider with a mark that follows BB's light and dark themes.
- The models your fx account can use, named and described from the Vercel AI Gateway catalog, with fx's configured model as the default, current flagship models first, and the rest under More models.
- Each model's own reasoning efforts, starting at Medium where offered.
- Session restore and streamed text and tool activity through BB's shared Agent Client Protocol bridge.
- BB permission controls for approval requests forwarded by fx, with workspace edits approved in `accept-edits` mode.
- Replies free of fx's diagnostic notices, which appear as reasoning instead.

## Requirements

Install BB 0.44.0 or newer and the [fx CLI](https://fx.sh/) on each machine where you want to run fx threads. The `fx` executable must be on that machine's `PATH`. Run `fx login` there to authenticate. Model access, usage limits, and any service charges depend on your fx account and model provider.

## Permissions and limits

The plugin starts `fx acp` with `FX_PERMISSION_MODE=ask`. File edits inside the thread's workspace and calls to BB's own tools are approved without asking, in every permission mode. BB decides the other requests fx sends, such as shell commands and edits outside the workspace, according to the thread's permission mode. Existing fx permission rules, session grants, and tool restrictions still apply before a request reaches BB.

Choosing a reasoning effort needs fx 0.0.9 or later. Session forks, service tiers, manual compaction, and provider-side thread renaming or archiving are not offered. The plugin stores no account credentials of its own; the fx CLI manages authentication and communicates with its services.

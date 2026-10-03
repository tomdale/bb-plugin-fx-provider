import { lstatSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

/**
 * The adapter's edit grant: a JSON array of the absolute write roots that BB
 * grants beyond the session workspace. host.ts sets it on the launch spec of
 * every session request it rewrites; the adapter approves fx file edits only
 * while it holds a grant.
 *
 * Every BB permission mode approves file changes inside the workspace write
 * roots, so the grant is the same whichever mode is selected and switching
 * modes does not disturb the session. The shared bridge compares the agent
 * environment at each `turn/start` that carries BB's thread environment (BB
 * always sends it) and rebuilds the session when it differs, so a turn whose
 * policy withholds the grant or changes the roots never runs under an older
 * grant.
 */
export const FX_EDIT_ROOTS_ENV = "BB_FX_EDIT_ROOTS";

/** BB permission modes that approve file changes inside the write roots. */
const EDIT_APPROVING_MODES = new Set(["accept-edits", "auto", "full"]);

/** The adapter environment for one bridge request's execution options. */
export function fxEditGrantEnv(options: unknown): Record<string, string> {
  if (options === null || typeof options !== "object") return {};
  const { permissionMode, providerOptions } = options as Record<
    string,
    unknown
  >;
  if (typeof permissionMode !== "string") return {};
  if (!EDIT_APPROVING_MODES.has(permissionMode)) return {};
  const extra =
    providerOptions !== null && typeof providerOptions === "object"
      ? (providerOptions as Record<string, unknown>)
          .additionalWorkspaceWriteRoots
      : undefined;
  const roots = Array.isArray(extra)
    ? extra.filter(
        (root): root is string => typeof root === "string" && isAbsolute(root),
      )
    : [];
  return { [FX_EDIT_ROOTS_ENV]: JSON.stringify(roots) };
}

/** Reads the grant from the adapter environment; undefined means no grant. */
export function readFxEditGrant(
  env: NodeJS.ProcessEnv,
): readonly string[] | undefined {
  const raw = env[FX_EDIT_ROOTS_ENV];
  if (raw === undefined) return undefined;
  try {
    const roots: unknown = JSON.parse(raw);
    return Array.isArray(roots) &&
      roots.every((root) => typeof root === "string" && isAbsolute(root))
      ? roots
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The physical location fx writes for a tool's `path` argument, or undefined
 * when the adapter cannot be certain of it.
 *
 * fx resolves a relative path against the session workspace and follows
 * symlinks. Refusing `..` segments keeps lexical and physical resolution
 * equal, and the existing part of the path is resolved through the
 * filesystem, so a symlink into another directory is judged by its target.
 * Home-relative paths and surrounding whitespace, which fx expands or trims,
 * are left for the user to decide.
 */
export function fxWriteTarget(
  path: string,
  workspace: string,
): string | undefined {
  if (
    path.length === 0 ||
    path !== path.trim() ||
    path.includes("\0") ||
    path.startsWith("~") ||
    path.split(/[\\/]/).includes("..")
  ) {
    return undefined;
  }
  return physicalPath(isAbsolute(path) ? path : join(workspace, path));
}

/** Resolves symlinks in the deepest existing ancestor of an absolute path. */
export function physicalPath(path: string): string | undefined {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      try {
        // An entry that exists but cannot be resolved is a dangling symlink:
        // writing through it creates the file at the link's target.
        lstatSync(current);
        return undefined;
      } catch {
        // Not yet created; judge it by the directory it would be created in.
      }
      const parent = dirname(current);
      if (parent === current) return undefined;
      missing.push(basename(current));
      current = parent;
    }
  }
}

export function isInsideRoot(target: string, root: string): boolean {
  const path = relative(root, target);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

/** fx file tools whose single `path` argument names the file they mutate. */
const FX_FILE_EDIT_TOOLS = new Set(["write_file", "edit_file"]);

/**
 * Whether a permission request is an fx file edit confined to the write
 * roots. Anything else, including edits of an unknown shape, edits outside
 * the roots, and deletes or moves (which fx performs through shell commands),
 * is for BB to decide.
 */
export function isFxWorkspaceEdit(
  toolCall: unknown,
  workspace: string,
  roots: readonly string[],
): boolean {
  if (toolCall === null || typeof toolCall !== "object") return false;
  const { name, kind, rawInput, locations } = toolCall as Record<
    string,
    unknown
  >;
  if (typeof name !== "string" || !FX_FILE_EDIT_TOOLS.has(name)) return false;
  if (kind !== "edit") return false;
  const path =
    rawInput !== null && typeof rawInput === "object"
      ? (rawInput as Record<string, unknown>).path
      : undefined;
  if (typeof path !== "string") return false;
  const paths = [path];
  if (locations !== undefined) {
    if (!Array.isArray(locations)) return false;
    for (const location of locations) {
      const located =
        location !== null && typeof location === "object"
          ? (location as Record<string, unknown>).path
          : undefined;
      if (typeof located !== "string") return false;
      paths.push(located);
    }
  }
  const physicalRoots = roots.flatMap((root) => physicalPath(root) ?? []);
  return paths.every((candidate) => {
    const target = fxWriteTarget(candidate, workspace);
    return (
      target !== undefined &&
      physicalRoots.some((root) => isInsideRoot(target, root))
    );
  });
}

/**
 * The SDK serves BB's dynamic tools to an ACP agent from one stdio MCP server
 * whose environment carries the tool list and the bridge's per-process
 * authentication token. Matching that contract, rather than a server name,
 * keeps a user's own MCP server out of the auto-approved set.
 */
const BB_TOOLS_ENV = "BB_ACP_DYNAMIC_TOOLS";
const BB_TOOL_TOKEN_ENV = "BB_ACP_DYNAMIC_TOOL_TOKEN";

export interface FxBbToolServer {
  /** The MCP server name fx sees. */
  server: string;
  /** BB tool names as the server lists them. */
  tools: ReadonlySet<string>;
  /** The names fx gives those tools, `mcp_<server>_<tool>`. */
  aliases: ReadonlySet<string>;
}

/** Finds BB's tool server among a session request's `mcpServers`. */
export function findBbToolServer(
  mcpServers: unknown,
): FxBbToolServer | undefined {
  if (!Array.isArray(mcpServers)) return undefined;
  for (const config of mcpServers) {
    if (config === null || typeof config !== "object") continue;
    const { name, env } = config as Record<string, unknown>;
    if (typeof name !== "string" || !Array.isArray(env)) continue;
    const vars = new Map<string, unknown>();
    for (const entry of env) {
      if (entry !== null && typeof entry === "object") {
        const { name: key, value } = entry as Record<string, unknown>;
        if (typeof key === "string") vars.set(key, value);
      }
    }
    const token = vars.get(BB_TOOL_TOKEN_ENV);
    const listed = vars.get(BB_TOOLS_ENV);
    if (typeof token !== "string" || token === "") continue;
    if (typeof listed !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(listed);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const tools = new Set<string>();
    for (const tool of parsed) {
      const toolName =
        tool !== null && typeof tool === "object"
          ? (tool as Record<string, unknown>).name
          : undefined;
      if (typeof toolName === "string" && toolName !== "") tools.add(toolName);
    }
    return {
      server: name,
      tools,
      aliases: new Set([...tools].map((tool) => fxMcpToolAlias(name, tool))),
    };
  }
  return undefined;
}

/**
 * fx's name for an MCP tool: `mcp_`, the server and tool names with every
 * byte other than ASCII letters, digits, `_` and `-` replaced by `_`, capped
 * at 64 bytes. fx appends `_2`, `_3`, ... to resolve a collision; a suffixed
 * name never matches, so a colliding tool is left for BB to decide.
 */
export function fxMcpToolAlias(server: string, tool: string): string {
  const segment = (value: string, empty: string) => {
    if (value === "") return empty;
    let out = "";
    for (const byte of Buffer.from(value, "utf8")) {
      const identifier =
        (byte >= 0x30 && byte <= 0x39) ||
        (byte >= 0x41 && byte <= 0x5a) ||
        (byte >= 0x61 && byte <= 0x7a) ||
        byte === 0x5f ||
        byte === 0x2d;
      out += identifier ? String.fromCharCode(byte) : "_";
    }
    return out;
  };
  return `mcp_${segment(server, "server")}_${segment(tool, "tool")}`.slice(
    0,
    64,
  );
}

/**
 * The MCP identity fx attaches to a `tool_call` update as
 * `_meta.fx.toolCall.mcp` (fx releases after 0.0.12).
 */
export function fxToolCallMcpIdentity(
  update: unknown,
): { server: string; tool: string } | undefined {
  const mcp = (
    (
      ((update as { _meta?: unknown } | null)?._meta as { fx?: unknown })
        ?.fx as { toolCall?: unknown }
    )?.toolCall as { mcp?: unknown }
  )?.mcp as { server?: unknown; tool?: unknown } | undefined;
  return typeof mcp?.server === "string" && typeof mcp.tool === "string"
    ? { server: mcp.server, tool: mcp.tool }
    : undefined;
}

/**
 * Whether a permission request is for one of BB's own dynamic tools. BB
 * authorizes those itself, so they never need the user's approval here.
 */
export function isBbToolCall(
  toolCall: unknown,
  server: FxBbToolServer,
  identity: { server: string; tool: string } | undefined,
): boolean {
  if (identity !== undefined) {
    return identity.server === server.server && server.tools.has(identity.tool);
  }
  const name =
    toolCall !== null && typeof toolCall === "object"
      ? (toolCall as Record<string, unknown>).name
      : undefined;
  return typeof name === "string" && server.aliases.has(name);
}

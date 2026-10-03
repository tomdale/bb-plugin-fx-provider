import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FX_EDIT_ROOTS_ENV,
  findBbToolServer,
  fxEditGrantEnv,
  fxMcpToolAlias,
  fxToolCallMcpIdentity,
  fxWriteTarget,
  isBbToolCall,
  isFxWorkspaceEdit,
  isInsideRoot,
  readFxEditGrant,
} from "../src/fx-permissions.js";

let root: string;
let workspace: string;
let outside: string;

beforeEach(() => {
  // Resolve the temp dir itself: macOS reaches it through /var -> /private/var.
  root = realpathSync(mkdtempSync(join(tmpdir(), "fx-permissions-")));
  workspace = join(root, "workspace");
  outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("edit grant", () => {
  it.each(["accept-edits", "auto", "full"])(
    "grants workspace edits in %s mode with BB's extra write roots",
    (permissionMode) => {
      const env = fxEditGrantEnv({
        permissionMode,
        providerOptions: {
          additionalWorkspaceWriteRoots: ["/repo/.git", "relative", 7],
        },
      });
      expect(env).toEqual({ [FX_EDIT_ROOTS_ENV]: '["/repo/.git"]' });
      expect(readFxEditGrant(env)).toEqual(["/repo/.git"]);
    },
  );

  it("grants nothing for an unknown mode or a request without options", () => {
    expect(fxEditGrantEnv({ permissionMode: "readonly" })).toEqual({});
    expect(fxEditGrantEnv(undefined)).toEqual({});
    expect(fxEditGrantEnv({ providerOptions: {} })).toEqual({});
  });

  it("is the same grant whichever approving mode is selected", () => {
    // Switching between them must not rebuild the session.
    const modes = ["accept-edits", "full"].map((permissionMode) =>
      fxEditGrantEnv({ permissionMode, providerOptions: {} }),
    );
    expect(modes[0]).toEqual(modes[1]);
  });

  it.each([
    ["absent", undefined],
    ["malformed", "{"],
    ["not a list", '{"roots":[]}'],
    ["relative", '["repo"]'],
  ])("treats a %s grant as none", (_, value) => {
    expect(readFxEditGrant({ [FX_EDIT_ROOTS_ENV]: value })).toBeUndefined();
  });
});

describe("write targets", () => {
  it("resolves relative paths against the workspace, as fx does", () => {
    expect(fxWriteTarget("a/b.txt", workspace)).toBe(
      join(workspace, "a/b.txt"),
    );
    expect(fxWriteTarget(join(workspace, "c.txt"), workspace)).toBe(
      join(workspace, "c.txt"),
    );
  });

  it("judges a path by where its symlinks lead", () => {
    symlinkSync(outside, join(workspace, "link"));
    expect(fxWriteTarget("link/x.txt", workspace)).toBe(join(outside, "x.txt"));
  });

  it("refuses a dangling symlink, which fx would write through", () => {
    symlinkSync(join(outside, "missing.txt"), join(workspace, "dangling"));
    expect(fxWriteTarget("dangling", workspace)).toBeUndefined();
  });

  it.each([
    ["a parent segment", "../outside/x.txt"],
    ["a nested parent segment", "a/../../outside/x.txt"],
    ["a home-relative path", "~/x.txt"],
    ["surrounding whitespace", " x.txt"],
    ["an empty path", ""],
    ["a NUL byte", "x\0.txt"],
  ])("refuses %s", (_, path) => {
    expect(fxWriteTarget(path, workspace)).toBeUndefined();
  });

  it("refuses a path through a regular file", () => {
    writeFileSync(join(workspace, "file"), "");
    expect(fxWriteTarget("file/x.txt", workspace)).toBeUndefined();
  });

  it("compares whole path segments", () => {
    expect(isInsideRoot("/w", "/w")).toBe(true);
    expect(isInsideRoot("/w/..x/y", "/w")).toBe(true);
    expect(isInsideRoot("/w-other/y", "/w")).toBe(false);
    expect(isInsideRoot("/y", "/w")).toBe(false);
  });
});

describe("workspace edits", () => {
  const edit = (path: unknown, extra: Record<string, unknown> = {}) => ({
    toolCallId: "call_1",
    name: "write_file",
    title: "file_mutation",
    kind: "edit",
    status: "pending",
    rawInput: { path, content: "hi\n" },
    ...extra,
  });

  it("accepts fx's write_file and edit_file inside a root", () => {
    const roots = [workspace];
    expect(isFxWorkspaceEdit(edit("hello.txt"), workspace, roots)).toBe(true);
    expect(
      isFxWorkspaceEdit(
        {
          ...edit(join(workspace, "a.txt")),
          name: "edit_file",
          rawInput: { path: "a.txt", old_string: "a", new_string: "b" },
        },
        workspace,
        roots,
      ),
    ).toBe(true);
    expect(
      isFxWorkspaceEdit(edit(join(outside, "x")), workspace, [
        workspace,
        outside,
      ]),
    ).toBe(true);
  });

  it.each([
    ["outside every root", edit("/etc/hosts")],
    ["a command", { ...edit("x"), name: "shell", kind: "execute" }],
    ["an unknown edit tool", { ...edit("x"), name: "apply_patch" }],
    ["a non-edit kind", { ...edit("x"), kind: "other" }],
    ["no path", { ...edit("x"), rawInput: { content: "" } }],
    ["a non-string path", edit(42)],
    [
      "a location outside the roots",
      edit("x", { locations: [{ path: "/etc/hosts" }] }),
    ],
    ["malformed locations", edit("x", { locations: "x" })],
    ["no tool call", undefined],
  ])("rejects %s", (_, toolCall) => {
    expect(isFxWorkspaceEdit(toolCall, workspace, [workspace])).toBe(false);
  });
});

describe("BB's tool server", () => {
  const bbServer = (
    name = "bb-bridge",
    tools = [{ name: "ask_user_question" }],
  ) => ({
    name,
    command: "/usr/bin/node",
    args: ["host.js", "--mcp-stdio"],
    env: [
      { name: "BB_ACP_DYNAMIC_TOOL_TOKEN", value: "secret" },
      { name: "BB_ACP_DYNAMIC_TOOLS", value: JSON.stringify(tools) },
    ],
  });

  it("is recognized by the SDK's MCP server contract, not its name", () => {
    const user = { ...bbServer("bb-bridge"), env: [] };
    expect(findBbToolServer([user])).toBeUndefined();
    const found = findBbToolServer([user, bbServer("renamed")]);
    expect(found?.server).toBe("renamed");
    expect([...(found?.aliases ?? [])]).toEqual([
      "mcp_renamed_ask_user_question",
    ]);
  });

  it.each([
    [[], undefined],
    ["nope", undefined],
    [
      [{ ...bbServer(), env: [{ name: "BB_ACP_DYNAMIC_TOOLS", value: "[]" }] }],
      undefined,
    ],
    [
      [
        {
          ...bbServer(),
          env: [
            { name: "BB_ACP_DYNAMIC_TOOL_TOKEN", value: "t" },
            { name: "BB_ACP_DYNAMIC_TOOLS", value: "{" },
          ],
        },
      ],
      undefined,
    ],
  ])("ignores incomplete configurations (%#)", (servers, expected) => {
    expect(findBbToolServer(servers)).toBe(expected);
  });

  it("names tools the way fx does", () => {
    expect(fxMcpToolAlias("bb-bridge", "echo")).toBe("mcp_bb-bridge_echo");
    expect(fxMcpToolAlias("a.b/c", "é")).toBe("mcp_a_b_c___");
    expect(fxMcpToolAlias("", "")).toBe("mcp_server_tool");
    expect(fxMcpToolAlias("bb-bridge", "x".repeat(80))).toHaveLength(64);
  });

  it("matches a request by fx's tool name or by its MCP identity", () => {
    const server = findBbToolServer([bbServer()])!;
    const call = { name: "mcp_bb-bridge_ask_user_question", kind: "other" };
    expect(isBbToolCall(call, server, undefined)).toBe(true);
    expect(
      isBbToolCall(
        { name: "mcp_bb-bridge_ask_user_question_2" },
        server,
        undefined,
      ),
    ).toBe(false);
    expect(
      isBbToolCall({ name: "mcp_other_ask_user_question" }, server, undefined),
    ).toBe(false);
    // The identity fx attaches is authoritative when present.
    expect(
      isBbToolCall({ name: "renamed" }, server, {
        server: "bb-bridge",
        tool: "ask_user_question",
      }),
    ).toBe(true);
    expect(
      isBbToolCall(call, server, { server: "user", tool: "ask_user_question" }),
    ).toBe(false);
  });

  it("reads fx's MCP identity from a tool_call update", () => {
    expect(
      fxToolCallMcpIdentity({
        sessionUpdate: "tool_call",
        _meta: {
          fx: {
            toolCall: { internal: false, mcp: { server: "s", tool: "t" } },
          },
        },
      }),
    ).toEqual({ server: "s", tool: "t" });
    expect(
      fxToolCallMcpIdentity({ sessionUpdate: "tool_call" }),
    ).toBeUndefined();
    expect(fxToolCallMcpIdentity(null)).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { FxAcpAdapter } from "../src/fx-acp.js";

const result = {
  content: [
    { type: "text", text: "First line\nSecond line" },
    { type: "text", text: "Third line" },
  ],
};
const envelope = { server: "bb-bridge", tool: "mcp_bb-bridge_todo", result };

function forwarded(update: Record<string, unknown>) {
  const message = {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "s1", update },
  };
  const output = new FxAcpAdapter(undefined).fromAgent(JSON.stringify(message));
  return JSON.parse(output.bridge!).params.update;
}

describe("MCP result display", () => {
  it.each(["tool_call", "tool_call_update"])(
    "unwraps serialized results in %s and replaces duplicated display text",
    (sessionUpdate) => {
      const rawOutput = JSON.stringify(envelope);
      expect(
        forwarded({
          sessionUpdate,
          toolCallId: "c",
          status: "completed",
          rawOutput,
          content: [{ type: "content", content: { type: "text", text: rawOutput } }],
        }),
      ).toEqual({
        sessionUpdate,
        toolCallId: "c",
        status: "completed",
        rawOutput: result,
        content: [{
          type: "content",
          content: { type: "text", text: "First line\nSecond line\nThird line" },
        }],
      });
    },
  );

  it("preserves failed status, error metadata, non-text blocks, and separate content", () => {
    const failed = {
      content: [
        { type: "text", text: "Request failed" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
      isError: true,
      structuredContent: { reason: "unavailable" },
    };
    const content = [{ type: "content", content: { type: "text", text: "Details" } }];
    expect(forwarded({
      sessionUpdate: "tool_call_update",
      toolCallId: "c",
      status: "failed",
      rawOutput: { ...envelope, result: failed },
      content,
    })).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "c",
      status: "failed",
      rawOutput: failed,
      content,
    });
  });

  it.each([
    "ordinary output",
    '{"server":',
    JSON.stringify(result),
    { result },
    { ...envelope, result: { content: "plain" } },
    { ...envelope, result: { content: [null] } },
    { ...envelope, result: { content: [{ text: "missing type" }] } },
  ])("leaves unrelated or malformed output unchanged: %j", (rawOutput) => {
    const update = { sessionUpdate: "tool_call_update", toolCallId: "c", rawOutput };
    expect(forwarded(update)).toEqual(update);
  });
});

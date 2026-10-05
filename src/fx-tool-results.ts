import { extractResultText } from "@get-bb/plugin-sdk/provider-bridge";

type Update = Record<string, unknown>;

function record(value: unknown): Update | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Update)
    : undefined;
}

/**
 * fx serializes MCP results inside a {server, tool, result} envelope. The
 * bridge reads rawOutput for the result and ACP content for its display text,
 * so unwrap both when content repeats that envelope. Preserve the MCP blocks
 * in rawOutput, including images and error metadata.
 */
export function normalizeFxToolResult(update: Update): Update {
  if (
    update.sessionUpdate !== "tool_call" &&
    update.sessionUpdate !== "tool_call_update"
  ) {
    return update;
  }
  let output = update.rawOutput;
  if (typeof output === "string") {
    try {
      output = JSON.parse(output);
    } catch {
      return update;
    }
  }
  const envelope = record(output);
  const result = record(envelope?.result);
  if (
    typeof envelope?.server !== "string" ||
    typeof envelope.tool !== "string" ||
    result === undefined ||
    !Array.isArray(result.content) ||
    !result.content.every((block) => typeof record(block)?.type === "string")
  ) {
    return update;
  }
  const serialized =
    typeof update.rawOutput === "string"
      ? update.rawOutput
      : JSON.stringify(output);
  const content = Array.isArray(update.content)
    ? update.content.map((entry) => {
        const block = record(entry);
        const value = record(block?.content);
        return block?.type === "content" &&
          value?.type === "text" &&
          value.text === serialized
          ? { ...block, content: { ...value, text: extractResultText(result) } }
          : entry;
      })
    : update.content;
  return {
    ...update,
    rawOutput: result,
    ...(content === undefined ? {} : { content }),
  };
}

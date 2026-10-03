import { describe, expect, it } from "vitest";
import { FxTranscript, isFxContextNotice } from "../src/fx-transcript.js";

// The warning fx 0.0.10 and 0.0.12 sent at the start of every session on a
// machine with two unparseable Claude skills.
const SKILL_WARNING =
  'skill discovery warning: candidate "/Users/u/.claude/skills/interactive-shell" was skipped because its metadata is invalid (unsupported_multiline); use one safe name and an optional inline description or a >, >-, or | block, then reload skills; candidate "/Users/u/.claude/skills/tui-development" was skipped because its metadata is invalid (unsupported_multiline); use one safe name and an optional inline description or a >, >-, or | block, then reload skills; relaunch with FX_TRACE=1 to write a trace log';

// The notice fx 0.0.10 sent in BB when it searched BB's AskUserQuestion tool,
// whose description exceeds fx's default description budget.
const CONTEXT_NOTICE =
  '[context] MCP description for "mcp_bb-bridge_AskUserQuestion" truncated: observed=1435 bytes effective=1024 bytes source=compiled default; override with --context-limit mcp_description_bytes=BYTES|off\n';

const chunk = (messageId: string | undefined, text: string) => ({
  sessionUpdate: "agent_message_chunk",
  ...(messageId === undefined ? {} : { messageId }),
  content: { type: "text", text },
});

/** Feeds updates through one transcript and returns what reaches the bridge. */
function run(updates: Record<string, unknown>[]) {
  const transcript = new FxTranscript();
  return updates.map((update) => transcript.rewrite(update));
}

/** The assistant text the shared bridge would stream from the output. */
function replyText(updates: Record<string, unknown>[]) {
  return updates
    .filter((update) => update.sessionUpdate === "agent_message_chunk")
    .map((update) => (update.content as { text: string }).text)
    .join("");
}

describe("fx's context notices", () => {
  it("are recognized only in the frames fx writes", () => {
    expect(isFxContextNotice(SKILL_WARNING)).toBe(true);
    expect(
      isFxContextNotice(
        'skill discovery warning: candidate "x" was skipped; see "/tmp/fx.trace" for details',
      ),
    ).toBe(true);
    expect(isFxContextNotice(CONTEXT_NOTICE)).toBe(true);
    expect(
      isFxContextNotice("[context] first warning\n[context]\n[context] second"),
    ).toBe(true);
    for (const text of [
      "skill discovery warning: incomplete",
      `Note: ${SKILL_WARNING}`,
      "[context] notice\nfollowed by prose",
      "[context] ",
      "[context]",
      "[contextual] x",
      "",
    ]) {
      expect(isFxContextNotice(text), text).toBe(false);
    }
  });

  it("move a context-budget notice out of the reply that follows it", () => {
    // fx's notice and the model's next sentence arrive under two message
    // ids with no tool call between them.
    const output = run([
      chunk("n1", CONTEXT_NOTICE),
      chunk("m1", "I found the tool and I'm selecting it now."),
    ]);
    expect(output[0]?.sessionUpdate).toBe("agent_thought_chunk");
    expect(replyText(output)).toBe(
      "I found the tool and I'm selecting it now.",
    );
  });

  it("moves to the thought channel and leaves the reply intact", () => {
    const output = run([
      chunk("n1", SKILL_WARNING),
      chunk("m1", "o"),
      chunk("m1", "k"),
    ]);
    expect(output[0]).toEqual({
      sessionUpdate: "agent_thought_chunk",
      messageId: "n1",
      content: { type: "text", text: SKILL_WARNING },
    });
    expect(replyText(output)).toBe("ok");
  });

  it("stays in the reply when it continues an open message", () => {
    const output = run([
      chunk("m1", "Quoting fx: "),
      chunk("m1", SKILL_WARNING),
    ]);
    expect(replyText(output)).toBe(`Quoting fx: ${SKILL_WARNING}`);
  });

  it("does not take later notices under the same message id with it", () => {
    // fx keeps one message id across consecutive operational emissions.
    const output = run([
      chunk("n1", SKILL_WARNING),
      chunk("n1", "HTTP 401: sign in again"),
    ]);
    expect(output[0]?.sessionUpdate).toBe("agent_thought_chunk");
    expect(replyText(output)).toBe("HTTP 401: sign in again");
  });

  it("starts a new paragraph when model reasoning is still open", () => {
    const output = run([
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Thinking" },
      },
      chunk("n1", SKILL_WARNING),
    ]);
    expect((output[1]?.content as { text: string }).text).toBe(
      `\n\n${SKILL_WARNING}`,
    );
  });
});

describe("message boundaries", () => {
  it("start a new paragraph within one open reply", () => {
    const output = run([
      chunk("m1", "first"),
      chunk("n1", "HTTP 500: upstream unavailable"),
      chunk("m2", "second"),
    ]);
    expect(replyText(output)).toBe(
      "first\n\nHTTP 500: upstream unavailable\n\nsecond",
    );
  });

  it("reuse newlines already at the boundary", () => {
    expect(replyText(run([chunk("m1", "a\n"), chunk("m2", "b")]))).toBe(
      "a\n\nb",
    );
    expect(replyText(run([chunk("m1", "a\n\n"), chunk("m2", "b")]))).toBe(
      "a\n\nb",
    );
    expect(replyText(run([chunk("m1", "a"), chunk("m2", "\nb")]))).toBe(
      "a\n\nb",
    );
    expect(
      replyText(run([chunk("m1", "a"), chunk("m1", "\n"), chunk("m2", "\nb")])),
    ).toBe("a\n\nb");
  });

  it("are left alone once a tool call has closed the reply", () => {
    // The bridge starts a new assistant item after the tool call.
    const done = chunk("m2", "done");
    const output = run([
      chunk("m1", "I'll write it."),
      { sessionUpdate: "tool_call", toolCallId: "c1", kind: "edit" },
      done,
    ]);
    expect(output[2]).toBe(done);
  });

  it("survive reasoning between messages, which keeps the reply open", () => {
    const output = run([
      chunk("m1", "a"),
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "hmm" },
      },
      chunk("m2", "b"),
    ]);
    expect(replyText(output)).toBe("a\n\nb");
  });

  it("are not inferred without message ids", () => {
    expect(replyText(run([chunk(undefined, "a"), chunk(undefined, "b")]))).toBe(
      "ab",
    );
    expect(replyText(run([chunk("m1", "a"), chunk(undefined, "b")]))).toBe(
      "ab",
    );
  });

  it("reset at the start of each prompt", () => {
    const transcript = new FxTranscript();
    transcript.rewrite(chunk("m1", "a"));
    transcript.reset();
    const next = chunk("m2", "b");
    expect(transcript.rewrite(next)).toBe(next);
  });
});

it("passes unchanged updates through as the same object", () => {
  const transcript = new FxTranscript();
  for (const update of [
    chunk("m1", "a"),
    chunk("m1", "b"),
    {
      sessionUpdate: "agent_message_chunk",
      messageId: "m2",
      content: { type: "image", data: "" },
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "completed",
    },
    { sessionUpdate: "usage_update", used: 1, size: 2 },
  ]) {
    expect(transcript.rewrite(update)).toBe(update);
  }
});

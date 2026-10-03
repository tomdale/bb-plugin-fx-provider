/**
 * Keeps fx's operational text from running into the assistant reply.
 *
 * fx sends its own notices (diagnostics, HTTP errors, restart markers) as
 * `agent_message_chunk` updates under a message id of their own, but the
 * shared bridge streams every message chunk into one assistant item until a
 * tool call or the end of the turn closes it. Two signals are used:
 *
 * - A message id change within one open assistant item starts a new
 *   paragraph, so whatever fx interjects stays visible and readable.
 * - fx's context notices are re-sent as `agent_thought_chunk`s: the skill
 *   discovery warning it repeats at the start of every session, and the
 *   `[context]` lines that report context-budget truncation (for example of
 *   a long MCP tool description). fx does not tag operational text, so these
 *   are recognized by the exact frames fx writes, and only as a complete
 *   chunk that would start a new message in the reply. fx keeps one id
 *   across consecutive notices, so each chunk is judged on its own: an HTTP
 *   error that follows a context notice stays in the reply.
 */

const SKILL_WARNING_PREFIX = "skill discovery warning: ";
const SKILL_WARNING_ENDING =
  /; (?:relaunch with FX_TRACE=1 to write a trace log|see ".*" for details)\s*$/s;
/** fx marks every line of a context-budget notice with `[context] `. */
const CONTEXT_LINE = /^\[context\] \S/;

/** Whether a chunk is one of fx's complete context notices. */
export function isFxContextNotice(text: string): boolean {
  if (text.startsWith(SKILL_WARNING_PREFIX)) {
    return SKILL_WARNING_ENDING.test(text);
  }
  // A bare `[context]` line is an empty line within a notice.
  const lines = text.replace(/\n+$/, "").split("\n");
  return (
    lines.some((line) => CONTEXT_LINE.test(line)) &&
    lines.every((line) => line === "[context]" || CONTEXT_LINE.test(line))
  );
}

type Update = Record<string, unknown>;

function chunkText(update: Update): string | undefined {
  const content = update.content as { type?: unknown; text?: unknown };
  return content?.type === "text" && typeof content.text === "string"
    ? content.text
    : undefined;
}

function withText(update: Update, text: string): Update {
  return { ...update, content: { ...(update.content as object), text } };
}

function leadingNewlines(text: string): number {
  let count = 0;
  while (count < 2 && text[count] === "\n") count += 1;
  return count;
}

function trailingNewlines(text: string, previous: number): number {
  let count = 0;
  while (count < text.length && text[text.length - 1 - count] === "\n") {
    count += 1;
  }
  return Math.min(2, count === text.length ? previous + count : count);
}

/**
 * Tracks the assistant and thought items the shared bridge has open for one
 * session, following its rules: a message chunk closes the thought item, and
 * a `tool_call` or the end of a prompt closes both.
 */
export class FxTranscript {
  private messageId: string | undefined;
  private messageOpen = false;
  private messageNewlines = 0;
  private thoughtOpen = false;

  /** A prompt starts with no open items. */
  reset(): void {
    this.messageId = undefined;
    this.messageOpen = false;
    this.messageNewlines = 0;
    this.thoughtOpen = false;
  }

  /** Returns the update to forward: the same object when nothing changes. */
  rewrite(update: Update): Update {
    switch (update.sessionUpdate) {
      case "tool_call":
        this.messageOpen = false;
        this.thoughtOpen = false;
        return update;
      case "agent_thought_chunk":
        if (chunkText(update) !== undefined) this.thoughtOpen = true;
        return update;
      case "agent_message_chunk":
        return this.rewriteMessage(update);
      default:
        return update;
    }
  }

  private rewriteMessage(update: Update): Update {
    const text = chunkText(update);
    if (text === undefined) return update;
    const id = typeof update.messageId === "string" ? update.messageId : "";
    const newMessage = id !== "" && id !== this.messageId;
    if (newMessage && isFxContextNotice(text)) {
      const thought = this.thoughtOpen ? `\n\n${text}` : text;
      this.thoughtOpen = true;
      return {
        ...withText(update, thought),
        sessionUpdate: "agent_thought_chunk",
      };
    }
    let output = text;
    if (newMessage && this.messageOpen && this.messageId !== undefined) {
      const gap = Math.max(0, 2 - this.messageNewlines - leadingNewlines(text));
      output = "\n".repeat(gap) + text;
    }
    if (id !== "") this.messageId = id;
    this.messageOpen = true;
    this.thoughtOpen = false;
    this.messageNewlines = trailingNewlines(output, this.messageNewlines);
    return output === text ? update : withText(update, output);
  }
}

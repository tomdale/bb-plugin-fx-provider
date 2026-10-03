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
 * - fx's skill discovery warning, a diagnostic it repeats at the start of
 *   every session, is re-sent as an `agent_thought_chunk`. fx does not tag
 *   operational text, so this one notice is recognized by the exact frame fx
 *   writes around it, and only as the complete first chunk of a message.
 *   Later chunks under the same id are other notices, such as an HTTP error,
 *   and stay in the reply.
 */

const SKILL_WARNING_PREFIX = "skill discovery warning: ";
const SKILL_WARNING_ENDING =
  /; (?:relaunch with FX_TRACE=1 to write a trace log|see ".*" for details)\s*$/s;

/** Whether a message's first chunk is fx's complete skill discovery warning. */
export function isFxSkillWarning(text: string): boolean {
  return (
    text.startsWith(SKILL_WARNING_PREFIX) && SKILL_WARNING_ENDING.test(text)
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
    if (newMessage && isFxSkillWarning(text)) {
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

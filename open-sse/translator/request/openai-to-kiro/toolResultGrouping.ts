type ContentBlock = {
  type?: string;
  text?: string;
};

type Message = {
  role?: string;
  content?: string | ContentBlock[] | null;
  tool_calls?: unknown[];
};

/** True when an Anthropic-style user message belongs to a tool-result batch. */
function carriesToolResults(message: Message): boolean {
  return (
    Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result")
  );
}

function isTextOnlyAssistant(message: Message): boolean {
  return (
    message.role === "assistant" &&
    (!message.tool_calls || message.tool_calls.length === 0) &&
    !(Array.isArray(message.content) && message.content.some((block) => block.type === "tool_use"))
  );
}

type Lookahead = "result" | "skip" | "stop";

function classifyLookahead(message: Message): Lookahead {
  if (message.role === "tool" || (message.role === "user" && carriesToolResults(message))) {
    return "result";
  }
  if (isTextOnlyAssistant(message)) return "skip";
  return "stop";
}

/**
 * Determine whether assistant prose is genuinely sandwiched inside one
 * tool-result batch, rather than being the ordinary final assistant reply.
 */
function hasFollowingToolResult(messages: Message[], index: number): boolean {
  for (let nextIndex = index + 1; nextIndex < messages.length; nextIndex++) {
    const classification = classifyLookahead(messages[nextIndex]);
    if (classification === "skip") continue;
    return classification === "result";
  }
  return false;
}

function assistantText(message: Message): string {
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block.type === "text" || block.text)
    .map((block) => block.text || "")
    .join("\n")
    .trim();
}

function isAccompanyingText(block: ContentBlock): boolean {
  return block.type !== "tool_result" && (block.type === "text" || Boolean(block.text));
}

function takeAccompanyingUserText(message: Message): string {
  if (message.role !== "user" || !Array.isArray(message.content)) return "";
  const textBlocks = message.content.filter(isAccompanyingText);
  message.content = message.content.filter((block) => !isAccompanyingText(block));
  return textBlocks
    .map((block) => block.text || "")
    .join("\n")
    .trim();
}

type DeferredTurn = { role: "assistant" | "user"; content: string };

function prependTrailingUserText(message: Message, turns: DeferredTurn[]): void {
  const trailing = turns[turns.length - 1];
  if (message.role !== "user" || trailing?.role !== "user") return;

  if (typeof message.content === "string") {
    message.content = `${trailing.content}\n\n${message.content}`;
  } else if (Array.isArray(message.content)) {
    message.content.unshift({ type: "text", text: trailing.content });
  } else {
    message.content = trailing.content;
  }
  turns.pop();
}

function toHistoryEntry(turn: DeferredTurn): Record<string, unknown> {
  if (turn.role === "assistant") {
    return { assistantResponseMessage: { content: turn.content } };
  }
  return {
    userInputMessage: { content: turn.content, modelId: "", origin: "AI_EDITOR" },
  };
}

/**
 * Holds text-only assistant messages while all results for one parallel tool
 * call are collected, then emits the prose immediately after that batch.
 */
export function createToolResultGrouping(messages: Message[]) {
  let deferredTurns: DeferredTurn[] = [];

  return {
    handle(
      message: Message,
      index: number,
      currentRole: unknown,
      pendingToolResultCount: number,
      flushPending: () => void
    ): boolean {
      if (
        isTextOnlyAssistant(message) &&
        currentRole === "user" &&
        pendingToolResultCount > 0 &&
        hasFollowingToolResult(messages, index)
      ) {
        const text = assistantText(message);
        if (text) deferredTurns.push({ role: "assistant", content: text });
        return true;
      }

      if (deferredTurns.length > 0 && carriesToolResults(message)) {
        const text = takeAccompanyingUserText(message);
        if (text) deferredTurns.push({ role: "user", content: text });
      }

      if (
        deferredTurns.length > 0 &&
        currentRole === "user" &&
        message.role !== "tool" &&
        !carriesToolResults(message)
      ) {
        prependTrailingUserText(message, deferredTurns);
        flushPending();
      }
      return false;
    },

    flushInto(history: Array<Record<string, unknown>>): void {
      if (deferredTurns.length === 0) return;
      history.push(...deferredTurns.map(toHistoryEntry));
      deferredTurns = [];
    },
  };
}

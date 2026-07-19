import type { AgentMessage, ContentPart, UserMessageContent } from "./provider/types.js";

export const DEFAULT_CONTEXT_CHARACTER_BUDGET = 160_000;
export const PERSISTED_MESSAGE_CHARACTER_BUDGET = 400_000;
const FULL_RECENT_TOOL_RESULTS = 2;
const COMPACT_TOOL_RESULT_CHARACTERS = 8_000;
const AGGRESSIVE_TOOL_RESULT_CHARACTERS = 2_000;
const MAX_EARLIER_SUMMARY_CHARACTERS = 12_000;
const MAX_CURRENT_TURN_WORKING_CHARACTERS = 16_000;
const MIN_EDITOR_CONTEXT_CHARACTERS = 4_000;
const LOW_DETAIL_IMAGE_CHARACTER_WEIGHT = 4_000;
const HIGH_DETAIL_IMAGE_CHARACTER_WEIGHT = 12_000;

export interface ContextPreparationStats {
  historyCharacters: number;
  contextCharacters: number;
  droppedMessages: number;
  compactedToolMessages: number;
  compacted: boolean;
}

export interface PreparedContext {
  messages: AgentMessage[];
  stats: ContextPreparationStats;
}

export function prepareSessionContext(
  messages: readonly AgentMessage[],
  maximumCharacters = DEFAULT_CONTEXT_CHARACTER_BUDGET,
): PreparedContext {
  return prepareSessionContextInternal(messages, maximumCharacters, true, true);
}

export function compactSessionMessages(
  messages: readonly AgentMessage[],
  maximumCharacters = PERSISTED_MESSAGE_CHARACTER_BUDGET,
): PreparedContext {
  return prepareSessionContextInternal(messages, maximumCharacters, false, false);
}

function prepareSessionContextInternal(
  messages: readonly AgentMessage[],
  maximumCharacters: number,
  protectLatestUser: boolean,
  omitHistoricalImages: boolean,
): PreparedContext {
  if (!Number.isInteger(maximumCharacters) || maximumCharacters < 16_000 || maximumCharacters > 2_000_000) {
    throw new Error("maximumCharacters must be an integer between 16000 and 2000000");
  }
  const historyCharacters = countMessageCharacters(messages);
  const providerMessages = omitHistoricalImages
    ? replaceAnsweredHistoricalImages(messages)
    : messages.map(cloneMessage);
  const historicalImagesCompacted = countImageParts(providerMessages) < countImageParts(messages);
  const toolIndexes = providerMessages.flatMap((message, index) => message.role === "tool" ? [index] : []);
  const recentFullTools = new Set(toolIndexes.slice(-FULL_RECENT_TOOL_RESULTS));
  let compactedToolMessages = 0;
  const normalized = providerMessages.map((message, index) => {
    if (message.role !== "tool" || recentFullTools.has(index) || message.content.length <= COMPACT_TOOL_RESULT_CHARACTERS) {
      return cloneMessage(message);
    }
    compactedToolMessages += 1;
    return { ...message, content: compactToolContent(message.content, COMPACT_TOOL_RESULT_CHARACTERS) };
  });

  const segments = splitConversationSegments(normalized);
  if (segments.length === 0) {
    return {
      messages: [],
      stats: {
        historyCharacters,
        contextCharacters: 0,
        droppedMessages: 0,
        compactedToolMessages,
        compacted: compactedToolMessages > 0 || historicalImagesCompacted,
      },
    };
  }

  let firstRetainedSegment = segments.length - 1;
  let retainedCharacters = countMessageCharacters(segments[firstRetainedSegment]!);
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const segmentCharacters = countMessageCharacters(segments[index]!);
    if (retainedCharacters + segmentCharacters > maximumCharacters - MAX_EARLIER_SUMMARY_CHARACTERS) break;
    firstRetainedSegment = index;
    retainedCharacters += segmentCharacters;
  }

  const omitted = segments.slice(0, firstRetainedSegment).flat();
  let retained = segments.slice(firstRetainedSegment).flat();
  const retainedBudget = maximumCharacters - (omitted.length > 0 ? 1_000 : 0);
  let protectedUserCompacted = false;
  if (protectLatestUser) {
    const protectedUser = protectCurrentUserMessage(retained, retainedBudget);
    retained = protectedUser.messages;
    protectedUserCompacted = protectedUser.compacted;
  }
  const fitted = fitMessagesToBudget(retained, retainedBudget, protectLatestUser);
  retained = fitted.messages;
  compactedToolMessages = Math.max(compactedToolMessages, fitted.compactedToolMessages);

  const result: AgentMessage[] = [];
  if (omitted.length > 0) {
    const available = Math.min(
      MAX_EARLIER_SUMMARY_CHARACTERS,
      Math.max(1, maximumCharacters - countMessageCharacters(retained)),
    );
    result.push({ role: "user", content: makeEarlierConversationSummary(omitted, available) });
  }
  result.push(...retained);
  const contextCharacters = countMessageCharacters(result);
  return {
    messages: result,
    stats: {
      historyCharacters,
      contextCharacters,
      droppedMessages: omitted.length + fitted.droppedMessages,
      compactedToolMessages,
      compacted:
        omitted.length > 0 ||
        fitted.droppedMessages > 0 ||
        compactedToolMessages > 0 ||
        protectedUserCompacted ||
        historicalImagesCompacted ||
        fitted.compactedOtherMessages,
    },
  };
}

function fitMessagesToBudget(
  messages: readonly AgentMessage[],
  maximumCharacters: number,
  protectLatestUser: boolean,
): {
  messages: AgentMessage[];
  compactedToolMessages: number;
  compactedOtherMessages: boolean;
  droppedMessages: number;
} {
  let compactedToolMessages = 0;
  let compactedOtherMessages = false;
  let droppedMessages = 0;
  let result = messages.map(cloneMessage);
  if (countMessageCharacters(result) <= maximumCharacters) {
    return { messages: result, compactedToolMessages, compactedOtherMessages, droppedMessages };
  }

  result = result.map((message) => {
    if (message.role !== "tool" || message.content.length <= AGGRESSIVE_TOOL_RESULT_CHARACTERS) return message;
    compactedToolMessages += 1;
    return { ...message, content: compactToolContent(message.content, AGGRESSIVE_TOOL_RESULT_CHARACTERS) };
  });
  if (countMessageCharacters(result) <= maximumCharacters) {
    return { messages: result, compactedToolMessages, compactedOtherMessages, droppedMessages };
  }

  result = result.map((message) => {
    if (message.role !== "assistant" || message.content.length <= 4_000) return message;
    compactedOtherMessages = true;
    return { ...message, content: truncate(message.content, 4_000) };
  });
  if (countMessageCharacters(result) <= maximumCharacters) {
    return { messages: result, compactedToolMessages, compactedOtherMessages, droppedMessages };
  }

  result = result.map((message) => {
    if (message.role !== "assistant") return message;
    const toolCalls = message.toolCalls.map((call) => {
      if (call.arguments.length <= 4_000) return call;
      compactedOtherMessages = true;
      return {
        ...call,
        arguments: JSON.stringify({ context_compacted: true, preview: truncate(call.arguments, 3_800) }),
      };
    });
    return { ...message, toolCalls };
  });
  if (countMessageCharacters(result) <= maximumCharacters) {
    return { messages: result, compactedToolMessages, compactedOtherMessages, droppedMessages };
  }

  for (let index = 0; index < result.length && countMessageCharacters(result) > maximumCharacters; index += 1) {
    const message = result[index];
    if (protectLatestUser && index === findLastUserIndex(result)) continue;
    if (message?.role !== "user" || userContentText(message.content).length <= 2_000) continue;
    const overage = countMessageCharacters(result) - maximumCharacters;
    const nextLength = Math.max(2_000, userContentText(message.content).length - overage);
    result[index] = { ...message, content: replaceUserContentText(message.content, truncate(userContentText(message.content), nextLength)) };
    compactedOtherMessages = true;
  }

  while (countMessageCharacters(result) > maximumCharacters) {
    const assistantIndex = result.findIndex(
      (message) => message.role === "assistant" && message.toolCalls.length > 0,
    );
    if (assistantIndex >= 0) {
      const assistant = result[assistantIndex];
      const callIds = new Set(assistant?.role === "assistant" ? assistant.toolCalls.map((call) => call.id) : []);
      let removalEnd = assistantIndex + 1;
      while (
        result[removalEnd]?.role === "tool" &&
        callIds.has((result[removalEnd] as Extract<AgentMessage, { role: "tool" }>).callId)
      ) {
        removalEnd += 1;
      }
      while (
        result[removalEnd]?.role === "user" &&
        Boolean((result[removalEnd] as Extract<AgentMessage, { role: "user" }>).synthetic) &&
        callIds.has(
          (result[removalEnd] as Extract<AgentMessage, { role: "user" }>).synthetic?.callId ?? "",
        )
      ) {
        removalEnd += 1;
      }
      droppedMessages += removalEnd - assistantIndex;
      result.splice(assistantIndex, removalEnd - assistantIndex);
      compactedOtherMessages = true;
      continue;
    }
    const removableIndex = result.findIndex((message, index) => (
      result.length > 1 && index < result.length - 1 && message.role !== "user"
    ));
    if (removableIndex >= 0) {
      result.splice(removableIndex, 1);
      droppedMessages += 1;
      compactedOtherMessages = true;
      continue;
    }
    const protectedUserIndex = protectLatestUser ? findLastUserIndex(result) : -1;
    const oversized = result.findIndex((message, index) => (
      index !== protectedUserIndex &&
      (message.role === "user" || message.role === "assistant") &&
      (message.role === "assistant" ? message.content.length > 0 : userContentText(message.content).length > 0)
    ));
    if (oversized < 0) {
      if (result.length === 0) break;
      result.shift();
      droppedMessages += 1;
      compactedOtherMessages = true;
      continue;
    }
    const message = result[oversized];
    if (!message || message.role === "tool") break;
    const overage = countMessageCharacters(result) - maximumCharacters;
    if (message.role === "assistant") {
      result[oversized] = {
        ...message,
        content: truncate(message.content, Math.max(0, message.content.length - overage)),
      };
    } else {
      const text = userContentText(message.content);
      result[oversized] = {
        ...message,
        content: replaceUserContentText(message.content, truncate(text, Math.max(0, text.length - overage))),
      };
    }
    compactedOtherMessages = true;
  }
  return { messages: result, compactedToolMessages, compactedOtherMessages, droppedMessages };
}

function protectCurrentUserMessage(
  messages: readonly AgentMessage[],
  maximumCharacters: number,
): { messages: AgentMessage[]; compacted: boolean } {
  const result = messages.map(cloneMessage);
  const userIndex = findLastUserIndex(result);
  if (userIndex < 0) return { messages: result, compacted: false };
  const message = result[userIndex];
  if (!message || message.role !== "user") return { messages: result, compacted: false };
  const workingReserve = Math.min(
    MAX_CURRENT_TURN_WORKING_CHARACTERS,
    Math.max(4_000, Math.floor(maximumCharacters / 4)),
  );
  const userBudget = maximumCharacters - workingReserve;
  const textContent = userContentText(message.content);
  const imageWeight = userContentImageWeight(message.content);
  const textBudget = userBudget - imageWeight;
  if (textBudget < 1) throw currentUserBudgetError(userBudget);
  const wrapped = /^<godot_editor_context>\s*\n?([\s\S]*?)\n?<\/godot_editor_context>\s*\n+User request:\s*\n([\s\S]*)$/u.exec(
    textContent,
  );
  if (!wrapped) {
    if (textContent.length > textBudget) throw currentUserBudgetError(textBudget);
    return { messages: result, compacted: false };
  }

  const editorContext = wrapped[1] ?? "";
  const userRequest = wrapped[2] ?? "";
  const prefix = "<godot_editor_context>\n";
  const separator = "\n</godot_editor_context>\n\nUser request:\n";
  const fixedCharacters = prefix.length + separator.length;
  const editorReserve = Math.min(MIN_EDITOR_CONTEXT_CHARACTERS, Math.floor(textBudget / 4));
  if (userRequest.length + fixedCharacters + editorReserve > textBudget) {
    throw currentUserBudgetError(Math.max(0, textBudget - fixedCharacters - editorReserve));
  }
  const editorBudget = textBudget - fixedCharacters - userRequest.length;
  result[userIndex] = {
    role: "user",
    content: replaceUserContentText(
      message.content,
      `${prefix}${truncate(editorContext, editorBudget)}${separator}${userRequest}`,
    ),
  };
  return { messages: result, compacted: editorContext.length > editorBudget };
}

function currentUserBudgetError(maximumCharacters: number): Error {
  return new Error(
    `Current user request exceeds the safe context budget (${maximumCharacters} characters); shorten it or split it into smaller tasks`,
  );
}

function findLastUserIndex(messages: readonly AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && !message.synthetic) return index;
  }
  return -1;
}

export function countMessageCharacters(messages: readonly AgentMessage[]): number {
  return messages.reduce((total, message) => {
    if (message.role === "assistant") {
      return total + message.content.length + (message.reasoningContent?.length ?? 0) + message.toolCalls.reduce(
        (callTotal, call) => callTotal + call.id.length + call.name.length + call.arguments.length,
        0,
      );
    }
    if (message.role === "tool") {
      return total + message.callId.length + message.name.length + message.content.length;
    }
    return total + userContentCharacterWeight(message.content);
  }, 0);
}

function splitConversationSegments(messages: readonly AgentMessage[]): AgentMessage[][] {
  const segments: AgentMessage[][] = [];
  for (const message of messages) {
    if ((message.role === "user" && !message.synthetic) || segments.length === 0) segments.push([]);
    segments.at(-1)!.push(message);
  }
  return segments;
}

function makeEarlierConversationSummary(messages: readonly AgentMessage[], maximumCharacters: number): string {
  const lines = [
    "[Earlier conversation compacted locally by GodotX. Tool details were omitted.]",
  ];
  for (const message of messages) {
    if (message.role === "tool") continue;
    const text = stripEditorContext(userContentText(message.content)).replace(/\s+/gu, " ").trim();
    if (!text) continue;
    const role = message.role === "user" ? "User" : "Assistant";
    lines.push(`${role}: ${truncate(text, 1_500)}`);
  }
  return truncate(lines.join("\n"), maximumCharacters);
}

function compactToolContent(content: string, maximumCharacters: number): string {
  if (content.length <= maximumCharacters) return content;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed)) {
      const summary: Record<string, unknown> = {
        persisted_context_truncated: true,
      };
      for (const key of [
        "ok",
        "error",
        "error_code",
        "path",
        "files",
        "query",
        "source",
        "title",
        "url",
        "status",
        "exit_code",
        "scene_path",
        "scene_id",
        "scene_revision",
        "operation_count",
        "change_count",
      ]) {
        if (key in parsed) summary[key] = parsed[key];
      }
      summary.preview = truncate(content, Math.max(256, maximumCharacters - 256));
      return truncate(JSON.stringify(summary), maximumCharacters);
    }
  } catch {
    // Plain-text tool output uses the same bounded preview below.
  }
  return truncate(content, maximumCharacters);
}

function cloneMessage(message: AgentMessage): AgentMessage {
  if (message.role === "assistant") {
    return { ...message, toolCalls: message.toolCalls.map((call) => ({ ...call })) };
  }
  if (message.role === "user" && Array.isArray(message.content)) {
    return {
      ...message,
      content: message.content.map(cloneContentPart),
      ...(message.synthetic ? { synthetic: { ...message.synthetic } } : {}),
    };
  }
  return { ...message };
}

export function userContentText(content: UserMessageContent): string {
  return typeof content === "string"
    ? content
    : content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
}

function userContentImageWeight(content: UserMessageContent): number {
  if (typeof content === "string") return 0;
  return content.reduce(
    (total, part) => total + (part.type === "image"
      ? part.detail === "high" ? HIGH_DETAIL_IMAGE_CHARACTER_WEIGHT : LOW_DETAIL_IMAGE_CHARACTER_WEIGHT
      : 0),
    0,
  );
}

function userContentCharacterWeight(content: UserMessageContent): number {
  return userContentText(content).length + userContentImageWeight(content);
}

function replaceUserContentText(content: UserMessageContent, text: string): UserMessageContent {
  if (typeof content === "string") return text;
  const result: ContentPart[] = [];
  let replaced = false;
  for (const part of content) {
    if (part.type === "text") {
      if (!replaced) result.push({ type: "text", text });
      replaced = true;
    } else {
      result.push(cloneContentPart(part));
    }
  }
  if (!replaced) result.unshift({ type: "text", text });
  return result;
}

function cloneContentPart(part: ContentPart): ContentPart {
  if (part.type === "text") return { ...part };
  return {
    ...part,
    ...(part.annotations
      ? { annotations: part.annotations.map((annotation) => ({
          ...annotation,
          start: [...annotation.start],
          end: [...annotation.end],
        })) }
      : {}),
  };
}

function replaceAnsweredHistoricalImages(messages: readonly AgentMessage[]): AgentMessage[] {
  const latestUserIndex = findLastUserIndex(messages);
  return messages.map((message, index) => {
    const cloned = cloneMessage(message);
    if (
      index >= latestUserIndex ||
      cloned.role !== "user" ||
      !Array.isArray(cloned.content) ||
      !cloned.content.some((part) => part.type === "image")
    ) {
      return cloned;
    }
    return {
      ...cloned,
      content: cloned.content.map((part): ContentPart => part.type === "image"
        ? {
            type: "text",
            text: `[Historical image ${part.attachmentId.slice(0, 12)} omitted from active context.]`,
          }
        : { ...part }),
    };
  });
}

function countImageParts(messages: readonly AgentMessage[]): number {
  return messages.reduce((total, message) => total + (
    message.role === "user" && Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "image").length
      : 0
  ), 0);
}

function stripEditorContext(value: string): string {
  return value.replace(/<godot_editor_context>[\s\S]*?<\/godot_editor_context>\s*/gu, "");
}

function truncate(value: string, maximumCharacters: number): string {
  if (value.length <= maximumCharacters) return value;
  const suffix = "\n[Content compacted]";
  if (maximumCharacters <= suffix.length) return suffix.slice(0, Math.max(0, maximumCharacters));
  return `${value.slice(0, Math.max(0, maximumCharacters - suffix.length)).trimEnd()}${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

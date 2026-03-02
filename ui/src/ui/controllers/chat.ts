import { parseAgentSessionKey } from "../../../../src/sessions/session-key-utils.js";
import { extractText } from "../chat/message-extract.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { ChatTransportMode } from "../storage.ts";
import type { ChatAttachment } from "../ui-types.ts";
import { generateUUID } from "../uuid.ts";

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatThinkingLevel: string | null;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatTransportMode?: ChatTransportMode;
  lastError: string | null;
  settings?: { chatTransportMode?: ChatTransportMode };
};

export type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

export type A2aEventPayload = {
  type: "a2a.task.status" | "a2a.message.delta" | "a2a.message.final" | "a2a.artifact.update";
  runId: string;
  taskId?: string;
  contextId?: string;
  payload?: Record<string, unknown>;
};

function decodeA2aContextSessionKey(sessionKey: string): string | null {
  const prefix = "agent:main:a2a:ctx:";
  if (!sessionKey.startsWith(prefix)) {
    return null;
  }
  const encoded = sessionKey.slice(prefix.length).trim();
  if (!encoded) {
    return null;
  }
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    return atob(padded);
  } catch {
    return null;
  }
}

function normalizeSessionAlias(value: string): string {
  const raw = value.trim();
  if (!raw) {
    return raw;
  }
  if (raw === "main") {
    return "agent:main:main";
  }
  const parsed = parseAgentSessionKey(raw);
  if (parsed?.agentId === "main" && parsed.rest === "main") {
    return "agent:main:main";
  }
  return raw;
}

function sessionKeysMatch(left: string, right: string): boolean {
  return normalizeSessionAlias(left) === normalizeSessionAlias(right);
}

function matchesChatEventSession(state: ChatState, payloadSessionKey: string): boolean {
  if (sessionKeysMatch(payloadSessionKey, state.sessionKey)) {
    return true;
  }
  const decodedContextId = decodeA2aContextSessionKey(payloadSessionKey);
  return decodedContextId ? sessionKeysMatch(decodedContextId, state.sessionKey) : false;
}

function resolveChatTransportMode(state: ChatState): ChatTransportMode {
  if (state.chatTransportMode === "a2a" || state.chatTransportMode === "chat") {
    return state.chatTransportMode;
  }
  const modeFromSettings = state.settings?.chatTransportMode;
  if (modeFromSettings === "a2a" || modeFromSettings === "chat") {
    return modeFromSettings;
  }
  return "chat";
}

export async function loadChatHistory(state: ChatState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.chatLoading = true;
  state.lastError = null;
  try {
    const res = await state.client.request<{ messages?: Array<unknown>; thinkingLevel?: string }>(
      "chat.history",
      {
        sessionKey: state.sessionKey,
        limit: 200,
      },
    );
    state.chatMessages = Array.isArray(res.messages) ? res.messages : [];
    state.chatThinkingLevel = res.thinkingLevel ?? null;
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.chatLoading = false;
  }
}

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return null;
  }
  return { mimeType: match[1], content: match[2] };
}

type AssistantMessageNormalizationOptions = {
  roleRequirement: "required" | "optional";
  roleCaseSensitive?: boolean;
  requireContentArray?: boolean;
  allowTextField?: boolean;
};

function normalizeAssistantMessage(
  message: unknown,
  options: AssistantMessageNormalizationOptions,
): Record<string, unknown> | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const candidate = message as Record<string, unknown>;
  const roleValue = candidate.role;
  if (typeof roleValue === "string") {
    const role = options.roleCaseSensitive ? roleValue : roleValue.toLowerCase();
    if (role !== "assistant") {
      return null;
    }
  } else if (options.roleRequirement === "required") {
    return null;
  }

  if (options.requireContentArray) {
    return Array.isArray(candidate.content) ? candidate : null;
  }
  if (!("content" in candidate) && !(options.allowTextField && "text" in candidate)) {
    return null;
  }
  return candidate;
}

function normalizeAbortedAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "required",
    roleCaseSensitive: true,
    requireContentArray: true,
  });
}

function normalizeFinalAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "optional",
    allowTextField: true,
  });
}

export async function sendChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) {
    return null;
  }

  const now = Date.now();

  // Build user message content blocks
  const contentBlocks: Array<{ type: string; text?: string; source?: unknown }> = [];
  if (msg) {
    contentBlocks.push({ type: "text", text: msg });
  }
  // Add image previews to the message for display
  if (hasAttachments) {
    for (const att of attachments) {
      contentBlocks.push({
        type: "image",
        source: { type: "base64", media_type: att.mimeType, data: att.dataUrl },
      });
    }
  }

  state.chatMessages = [
    ...state.chatMessages,
    {
      role: "user",
      content: contentBlocks,
      timestamp: now,
    },
  ];

  state.chatSending = true;
  state.lastError = null;
  const runId = generateUUID();
  state.chatRunId = runId;
  state.chatStream = "";
  state.chatStreamStartedAt = now;

  // Convert attachments to API format
  const apiAttachments = hasAttachments
    ? attachments
        .map((att) => {
          const parsed = dataUrlToBase64(att.dataUrl);
          if (!parsed) {
            return null;
          }
          return {
            type: "image",
            mimeType: parsed.mimeType,
            content: parsed.content,
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null)
    : undefined;

  try {
    if (resolveChatTransportMode(state) === "a2a") {
      const parts: Array<Record<string, unknown>> = [];
      if (msg) {
        parts.push({
          type: "text",
          text: msg,
        });
      }
      for (const att of apiAttachments ?? []) {
        parts.push({
          type: "file",
          contentType: att.mimeType,
          fileName: "image",
          base64: att.content,
        });
      }
      await state.client.request("a2a.send", {
        kind: "message",
        messageId: runId,
        contextId: state.sessionKey,
        parts,
      });
    } else {
      await state.client.request("chat.send", {
        sessionKey: state.sessionKey,
        message: msg,
        deliver: false,
        idempotencyKey: runId,
        attachments: apiAttachments,
      });
    }
    return runId;
  } catch (err) {
    const error = String(err);
    state.chatRunId = null;
    state.chatStream = null;
    state.chatStreamStartedAt = null;
    state.lastError = error;
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Error: " + error }],
        timestamp: Date.now(),
      },
    ];
    return null;
  } finally {
    state.chatSending = false;
  }
}

export async function abortChatRun(state: ChatState): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const runId = state.chatRunId;
  try {
    if (resolveChatTransportMode(state) === "a2a") {
      await state.client.request("a2a.cancel", {
        mode: runId ? "run" : "context",
        runId: runId ?? undefined,
        contextId: state.sessionKey,
      });
    } else {
      await state.client.request(
        "chat.abort",
        runId ? { sessionKey: state.sessionKey, runId } : { sessionKey: state.sessionKey },
      );
    }
    return true;
  } catch (err) {
    state.lastError = String(err);
    return false;
  }
}

export function handleChatEvent(state: ChatState, payload?: ChatEventPayload) {
  if (!payload) {
    return null;
  }
  if (!matchesChatEventSession(state, payload.sessionKey)) {
    return null;
  }

  // Final from another run (e.g. sub-agent announce): refresh history to show new message.
  // See https://github.com/openclaw/openclaw/issues/1909
  if (payload.runId && state.chatRunId && payload.runId !== state.chatRunId) {
    if (payload.state === "final") {
      const finalMessage = normalizeFinalAssistantMessage(payload.message);
      if (finalMessage) {
        state.chatMessages = [...state.chatMessages, finalMessage];
        return null;
      }
      return "final";
    }
    return null;
  }

  if (payload.state === "delta") {
    const next = extractText(payload.message);
    if (typeof next === "string") {
      const current = state.chatStream ?? "";
      if (!current || next.length >= current.length) {
        state.chatStream = next;
      }
    }
  } else if (payload.state === "final") {
    const finalMessage = normalizeFinalAssistantMessage(payload.message);
    if (finalMessage) {
      state.chatMessages = [...state.chatMessages, finalMessage];
    }
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "aborted") {
    const normalizedMessage = normalizeAbortedAssistantMessage(payload.message);
    if (normalizedMessage) {
      state.chatMessages = [...state.chatMessages, normalizedMessage];
    } else {
      const streamedText = state.chatStream ?? "";
      if (streamedText.trim()) {
        state.chatMessages = [
          ...state.chatMessages,
          {
            role: "assistant",
            content: [{ type: "text", text: streamedText }],
            timestamp: Date.now(),
          },
        ];
      }
    }
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "error") {
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    state.lastError = payload.errorMessage ?? "chat error";
  }
  return payload.state;
}

export function handleA2aEvent(state: ChatState, payload?: A2aEventPayload) {
  if (!payload) {
    return null;
  }
  const runId = payload.taskId ?? payload.runId;
  if (!runId) {
    return null;
  }
  const isActiveRun = Boolean(state.chatRunId && state.chatRunId === runId);
  if (payload.contextId && !sessionKeysMatch(payload.contextId, state.sessionKey) && !isActiveRun) {
    return null;
  }

  if (payload.type === "a2a.message.delta") {
    const text = typeof payload.payload?.text === "string" ? payload.payload.text : "";
    if (!text) {
      return null;
    }
    if (state.chatRunId && state.chatRunId !== runId) {
      return null;
    }
    if (!state.chatRunId) {
      state.chatRunId = runId;
      state.chatStream = "";
      state.chatStreamStartedAt = Date.now();
    }
    state.chatStream = `${state.chatStream ?? ""}${text}`;
    return "delta";
  }

  if (payload.type === "a2a.message.final") {
    const text = typeof payload.payload?.text === "string" ? payload.payload.text : "";
    if (state.chatRunId && state.chatRunId !== runId) {
      if (text.trim()) {
        state.chatMessages = [
          ...state.chatMessages,
          {
            role: "assistant",
            content: [{ type: "text", text }],
            timestamp: Date.now(),
          },
        ];
      }
      return "final";
    }
    if (text.trim()) {
      state.chatMessages = [
        ...state.chatMessages,
        {
          role: "assistant",
          content: [{ type: "text", text }],
          timestamp: Date.now(),
        },
      ];
    }
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    return "final";
  }

  if (payload.type === "a2a.task.status") {
    const taskState = payload.payload?.state;
    if (taskState === "failed") {
      const errorMessage =
        typeof payload.payload?.error === "string" ? payload.payload.error : "a2a error";
      state.chatStream = null;
      state.chatRunId = null;
      state.chatStreamStartedAt = null;
      state.lastError = errorMessage;
      return "error";
    }
    if (taskState === "cancelled") {
      state.chatStream = null;
      state.chatRunId = null;
      state.chatStreamStartedAt = null;
      return "aborted";
    }
  }
  return null;
}

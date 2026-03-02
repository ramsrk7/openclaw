import { describe, expect, it, vi } from "vitest";
import {
  handleA2aEvent,
  handleChatEvent,
  sendChatMessage,
  abortChatRun,
  type ChatEventPayload,
  type ChatState,
} from "./chat.ts";

function createState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    chatAttachments: [],
    chatLoading: false,
    chatMessage: "",
    chatMessages: [],
    chatRunId: null,
    chatSending: false,
    chatStream: null,
    chatStreamStartedAt: null,
    chatThinkingLevel: null,
    client: null,
    connected: true,
    lastError: null,
    sessionKey: "main",
    settings: { chatTransportMode: "chat" },
    ...overrides,
  };
}

describe("sendChatMessage transport mode", () => {
  it("uses chat.send in default mode", async () => {
    const request = vi.fn().mockResolvedValue({});
    const state = createState({
      client: { request } as unknown as ChatState["client"],
      connected: true,
    });
    await sendChatMessage(state, "hello");
    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "main",
        message: "hello",
      }),
    );
  });

  it("uses a2a.send in a2a mode", async () => {
    const request = vi.fn().mockResolvedValue({});
    const state = createState({
      client: { request } as unknown as ChatState["client"],
      connected: true,
      settings: { chatTransportMode: "a2a" },
    });
    await sendChatMessage(state, "hello");
    expect(request).toHaveBeenCalledWith(
      "a2a.send",
      expect.objectContaining({
        contextId: "main",
        kind: "message",
      }),
    );
  });

  it("uses a2a.cancel in a2a mode", async () => {
    const request = vi.fn().mockResolvedValue({});
    const state = createState({
      client: { request } as unknown as ChatState["client"],
      connected: true,
      chatRunId: "run-1",
      settings: { chatTransportMode: "a2a" },
    });
    await abortChatRun(state);
    expect(request).toHaveBeenCalledWith(
      "a2a.cancel",
      expect.objectContaining({
        runId: "run-1",
        contextId: "main",
        mode: "run",
      }),
    );
  });
});

describe("handleChatEvent", () => {
  it("returns null when payload is missing", () => {
    const state = createState();
    expect(handleChatEvent(state, undefined)).toBe(null);
  });

  it("returns null when sessionKey does not match", () => {
    const state = createState({ sessionKey: "main" });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "other",
      state: "final",
    };
    expect(handleChatEvent(state, payload)).toBe(null);
  });

  it("accepts chat events for encoded a2a session key mapped to active session", () => {
    const state = createState({ sessionKey: "agent:main:main" });
    const payload: ChatEventPayload = {
      runId: "run-a2a-chat",
      sessionKey: "agent:main:a2a:ctx:YWdlbnQ6bWFpbjptYWlu",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "A2A mapped response" }],
      },
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toHaveLength(1);
  });

  it("returns null for delta from another run", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Hello",
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
    };
    expect(handleChatEvent(state, payload)).toBe(null);
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Hello");
  });

  it("appends final payload from another run without clearing active stream", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Working...",
      chatStreamStartedAt: 123,
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Sub-agent findings" }],
      },
    };
    expect(handleChatEvent(state, payload)).toBe(null);
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
    expect(state.chatStreamStartedAt).toBe(123);
    expect(state.chatMessages).toHaveLength(1);
    expect(state.chatMessages[0]).toEqual(payload.message);
  });

  it("returns final for another run when payload has no message", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Working...",
      chatStreamStartedAt: 123,
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "final",
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatMessages).toEqual([]);
  });

  it("processes final from own run and clears state", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Reply",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
  });

  it("appends final payload message from own run before clearing stream state", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Reply",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Reply" }],
        timestamp: 101,
      },
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([payload.message]);
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
  });

  it("processes aborted from own run and keeps partial assistant message", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const partialMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Partial reply" }],
      timestamp: 2,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Partial reply",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      message: partialMessage,
    };

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
    expect(state.chatMessages).toEqual([existingMessage, partialMessage]);
  });

  it("falls back to streamed partial when aborted payload message is invalid", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Partial reply",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      message: "not-an-assistant-message",
    } as unknown as ChatEventPayload;

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[0]).toEqual(existingMessage);
    expect(state.chatMessages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Partial reply" }],
    });
  });

  it("falls back to streamed partial when aborted payload has non-assistant role", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Partial reply",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      message: {
        role: "user",
        content: [{ type: "text", text: "unexpected" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Partial reply" }],
    });
  });

  it("processes aborted from own run without message and empty stream", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
    };

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
    expect(state.chatMessages).toEqual([existingMessage]);
  });
});

describe("handleA2aEvent", () => {
  it("streams deltas and final message", () => {
    const state = createState({ sessionKey: "ctx-1" });
    expect(
      handleA2aEvent(state, {
        type: "a2a.message.delta",
        runId: "r1",
        taskId: "r1",
        contextId: "ctx-1",
        payload: { text: "Hello " },
      }),
    ).toBe("delta");
    expect(state.chatStream).toBe("Hello ");
    expect(
      handleA2aEvent(state, {
        type: "a2a.message.delta",
        runId: "r1",
        taskId: "r1",
        contextId: "ctx-1",
        payload: { text: "world" },
      }),
    ).toBe("delta");
    expect(state.chatStream).toBe("Hello world");
    expect(
      handleA2aEvent(state, {
        type: "a2a.message.final",
        runId: "r1",
        taskId: "r1",
        contextId: "ctx-1",
        payload: { text: "Hello world" },
      }),
    ).toBe("final");
    expect(state.chatMessages).toHaveLength(1);
    expect(state.chatRunId).toBeNull();
    expect(state.chatStream).toBeNull();
  });

  it("accepts events for active run even when contextId is mismatched", () => {
    const state = createState({
      sessionKey: "agent:main:main",
      chatRunId: "r-active",
      chatStream: "",
    });
    expect(
      handleA2aEvent(state, {
        type: "a2a.message.delta",
        runId: "r-active",
        taskId: "r-active",
        contextId: "garbled-context",
        payload: { text: "Hello" },
      }),
    ).toBe("delta");
    expect(state.chatStream).toBe("Hello");
  });
});

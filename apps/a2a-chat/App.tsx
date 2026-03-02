import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

type Role = "user" | "assistant" | "system";

type ChatBubble = {
  id: string;
  role: Role;
  text: string;
  runId?: string;
};

type GatewayReqFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

type GatewayResFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message?: string };
};

type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
};

type GatewayFrame = GatewayReqFrame | GatewayResFrame | GatewayEventFrame;

function nextId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function textFromContentBlock(block: unknown): string {
  if (!block || typeof block !== "object") {return "";}
  const value = block as Record<string, unknown>;
  if (typeof value.text === "string") {return value.text;}
  return "";
}

function extractMessageText(message: unknown): string {
  if (typeof message === "string") {return message;}
  if (!message || typeof message !== "object") {return "";}

  const shape = message as Record<string, unknown>;

  if (typeof shape.text === "string") {return shape.text;}
  if (typeof shape.content === "string") {return shape.content;}

  if (Array.isArray(shape.content)) {
    const joined = shape.content
      .map((entry) => textFromContentBlock(entry))
      .filter(Boolean)
      .join("\n");
    if (joined) {return joined;}
  }

  return "";
}

export default function App() {
  const wsRef = useRef<WebSocket | null>(null);
  const wsListenerRefs = useRef<{
    ws: WebSocket;
    open: () => void;
    message: (event: { data: unknown }) => void;
    error: () => void;
    close: () => void;
  } | null>(null);
  const pendingReqRef = useRef(new Map<string, (frame: GatewayResFrame) => void>());
  const runBubbleRef = useRef(new Map<string, string>());
  const scrollRef = useRef<ScrollView | null>(null);

  const [url, setUrl] = useState(process.env.EXPO_PUBLIC_A2A_WS_URL ?? "ws://127.0.0.1:18789");
  const [token, setToken] = useState(process.env.EXPO_PUBLIC_A2A_TOKEN ?? "");
  const [sessionKey, setSessionKey] = useState(process.env.EXPO_PUBLIC_A2A_SESSION_KEY ?? "main");
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected">(
    "disconnected",
  );
  const [messages, setMessages] = useState<ChatBubble[]>([]);

  const connected = status === "connected";

  const statusColor = useMemo(() => {
    if (status === "connected") {return "#2ecc71";}
    if (status === "connecting") {return "#f39c12";}
    return "#e74c3c";
  }, [status]);

  const appendSystem = useCallback((text: string) => {
    setMessages((prev) => [...prev, { id: nextId("system"), role: "system", text }]);
  }, []);

  const sendReq = useCallback((method: string, params?: unknown): Promise<GatewayResFrame> => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("WebSocket not connected."));
    }
    const id = nextId("req");
    const frame: GatewayReqFrame = { type: "req", id, method, params };
    return new Promise((resolve) => {
      pendingReqRef.current.set(id, resolve);
      ws.send(JSON.stringify(frame));
    });
  }, []);

  const upsertAssistantByRun = useCallback((runId: string, patchText: string, append = false) => {
    setMessages((prev) => {
      const existingId = runBubbleRef.current.get(runId);
      if (!existingId) {
        const bubbleId = nextId("assistant");
        runBubbleRef.current.set(runId, bubbleId);
        return [...prev, { id: bubbleId, role: "assistant", text: patchText, runId }];
      }
      return prev.map((entry) => {
        if (entry.id !== existingId) {return entry;}
        return {
          ...entry,
          text: append ? `${entry.text}${patchText}` : patchText,
        };
      });
    });
  }, []);

  const closeSocket = useCallback(() => {
    const ws = wsRef.current;
    if (ws) {
      const listenerRefs = wsListenerRefs.current;
      if (listenerRefs && listenerRefs.ws === ws) {
        ws.removeEventListener("open", listenerRefs.open);
        ws.removeEventListener("message", listenerRefs.message);
        ws.removeEventListener("error", listenerRefs.error);
        ws.removeEventListener("close", listenerRefs.close);
      }
      ws.close();
      wsRef.current = null;
    }
    wsListenerRefs.current = null;
    pendingReqRef.current.clear();
    runBubbleRef.current.clear();
    setStatus("disconnected");
  }, []);

  const connect = useCallback(async () => {
    if (status === "connecting" || status === "connected") {return;}
    setStatus("connecting");

    const ws = new WebSocket(url.trim());
    wsRef.current = ws;

    const onOpen = () => {
      const connectFrame: GatewayReqFrame = {
        type: "req",
        id: "connect-1",
        method: "connect",
        params: {
          minProtocol: 2,
          maxProtocol: 3,
          role: "operator",
          scopes: ["operator.read", "operator.write"],
          client: {
            id: "webchat-ui",
            displayName: "A2A Chat App",
            version: "0.1.0",
            platform: Platform.OS,
            mode: "webchat",
          },
          ...(token.trim() ? { auth: { token: token.trim() } } : {}),
        },
      };
      ws.send(JSON.stringify(connectFrame));
    };

    const onMessage = (event: { data: unknown }) => {
      let frame: GatewayFrame;
      try {
        frame = JSON.parse(String(event.data)) as GatewayFrame;
      } catch {
        return;
      }

      if (frame.type === "res") {
        if (frame.id === "connect-1") {
          if (frame.ok) {
            setStatus("connected");
            appendSystem("Connected.");
            sendReq("chat.history", { sessionKey, limit: 100 })
              .then((historyRes) => {
                if (!historyRes.ok) {return;}
                const payload = (historyRes.payload ?? {}) as {
                  messages?: Array<Record<string, unknown>>;
                };
                const history = Array.isArray(payload.messages) ? payload.messages : [];
                const mapped: ChatBubble[] = history
                  .map((msg, index) => {
                    const role = typeof msg.role === "string" ? msg.role : "system";
                    const text = extractMessageText(msg.content ?? msg.text ?? msg.message);
                    if (!text) {return null;}
                    return {
                      id: `history-${index}-${Date.now()}`,
                      role:
                        role === "user" || role === "assistant" || role === "system"
                          ? role
                          : "system",
                      text,
                    } as ChatBubble;
                  })
                  .filter((entry): entry is ChatBubble => entry !== null);
                setMessages(mapped);
              })
              .catch(() => {
                appendSystem("Connected, but failed to load chat history.");
              });
          } else {
            const err = frame.error?.message ?? "Connect failed.";
            appendSystem(err);
            closeSocket();
          }
          return;
        }
        const resolver = pendingReqRef.current.get(frame.id);
        if (resolver) {
          pendingReqRef.current.delete(frame.id);
          resolver(frame);
        }
        return;
      }

      if (frame.type === "event" && frame.event === "chat") {
        const payload = (frame.payload ?? {}) as {
          runId?: string;
          state?: string;
          message?: unknown;
          errorMessage?: string;
        };
        const runId = payload.runId ?? "";
        if (!runId) {return;}

        if (payload.state === "error") {
          upsertAssistantByRun(runId, payload.errorMessage || "Run failed.", false);
          return;
        }
        const text = extractMessageText(payload.message);
        if (!text) {return;}
        if (payload.state === "delta") {
          upsertAssistantByRun(runId, text, true);
        } else {
          upsertAssistantByRun(runId, text, false);
        }
      }
    };

    const onError = () => {
      appendSystem("WebSocket error.");
    };

    const onClose = () => {
      setStatus("disconnected");
      pendingReqRef.current.clear();
      runBubbleRef.current.clear();
      appendSystem("Disconnected.");
      wsListenerRefs.current = null;
    };
    wsListenerRefs.current = {
      ws,
      open: onOpen,
      message: onMessage,
      error: onError,
      close: onClose,
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
  }, [appendSystem, closeSocket, sendReq, sessionKey, status, token, upsertAssistantByRun, url]);

  const disconnect = useCallback(() => {
    closeSocket();
  }, [closeSocket]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || !connected) {return;}

    setInput("");
    setMessages((prev) => [...prev, { id: nextId("user"), role: "user", text }]);
    const idempotencyKey = nextId("chat");

    try {
      const res = await sendReq("chat.send", {
        sessionKey,
        message: text,
        idempotencyKey,
      });
      if (!res.ok) {
        appendSystem(res.error?.message ?? "chat.send failed.");
      }
    } catch (err) {
      appendSystem(err instanceof Error ? err.message : "chat.send failed.");
    }
  }, [appendSystem, connected, input, sendReq, sessionKey]);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [messages]);

  useEffect(() => {
    return () => {
      closeSocket();
    };
  }, [closeSocket]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.header}>
          <Text style={styles.title}>A2A Chat</Text>
          <View style={styles.statusRow}>
            <View style={[styles.dot, { backgroundColor: statusColor }]} />
            <Text style={styles.statusText}>{status}</Text>
          </View>
        </View>

        <View style={styles.config}>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            placeholder="ws://127.0.0.1:18789"
            placeholderTextColor="#94a3b8"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={styles.input}
            value={token}
            onChangeText={setToken}
            placeholder="Gateway token (optional)"
            placeholderTextColor="#94a3b8"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={styles.input}
            value={sessionKey}
            onChangeText={setSessionKey}
            placeholder="Session key (main)"
            placeholderTextColor="#94a3b8"
            autoCapitalize="none"
            autoCorrect={false}
          />

          <View style={styles.row}>
            <Pressable
              onPress={connect}
              disabled={connected || status === "connecting"}
              style={[styles.btn, styles.btnPrimary, (connected || status === "connecting") && styles.btnDim]}
            >
              <Text style={styles.btnText}>Connect</Text>
            </Pressable>
            <Pressable onPress={disconnect} disabled={!connected} style={[styles.btn, styles.btnSecondary, !connected && styles.btnDim]}>
              <Text style={styles.btnText}>Disconnect</Text>
            </Pressable>
          </View>
        </View>

        <ScrollView ref={scrollRef} style={styles.chat} contentContainerStyle={styles.chatContent}>
          {messages.map((msg) => (
            <View
              key={msg.id}
              style={[
                styles.bubble,
                msg.role === "user"
                  ? styles.userBubble
                  : msg.role === "assistant"
                    ? styles.assistantBubble
                    : styles.systemBubble,
              ]}
            >
              <Text style={styles.bubbleRole}>{msg.role}</Text>
              <Text style={styles.bubbleText}>{msg.text}</Text>
            </View>
          ))}
        </ScrollView>

        <View style={styles.composer}>
          <TextInput
            style={[styles.input, styles.composerInput]}
            value={input}
            onChangeText={setInput}
            placeholder="Type a message..."
            placeholderTextColor="#94a3b8"
            multiline
          />
          <Pressable
            onPress={sendMessage}
            disabled={!connected || input.trim().length === 0}
            style={[styles.btn, styles.btnPrimary, (!connected || input.trim().length === 0) && styles.btnDim]}
          >
            <Text style={styles.btnText}>Send</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#0b1220",
  },
  container: {
    flex: 1,
    paddingHorizontal: 12,
    paddingBottom: 12,
    gap: 10,
  },
  header: {
    paddingTop: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: {
    color: "#f8fafc",
    fontSize: 20,
    fontWeight: "700",
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 999,
  },
  statusText: {
    color: "#cbd5e1",
    textTransform: "capitalize",
  },
  config: {
    gap: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: "#1e293b",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    color: "#f8fafc",
    backgroundColor: "#111827",
  },
  row: {
    flexDirection: "row",
    gap: 8,
  },
  btn: {
    flex: 1,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 42,
    paddingHorizontal: 12,
  },
  btnPrimary: {
    backgroundColor: "#2563eb",
  },
  btnSecondary: {
    backgroundColor: "#334155",
  },
  btnDim: {
    opacity: 0.45,
  },
  btnText: {
    color: "#fff",
    fontWeight: "600",
  },
  chat: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#1e293b",
    backgroundColor: "#0f172a",
  },
  chatContent: {
    padding: 10,
    gap: 8,
  },
  bubble: {
    padding: 10,
    borderRadius: 10,
    gap: 4,
  },
  userBubble: {
    backgroundColor: "#1d4ed8",
    marginLeft: 24,
  },
  assistantBubble: {
    backgroundColor: "#334155",
    marginRight: 24,
  },
  systemBubble: {
    backgroundColor: "#374151",
  },
  bubbleRole: {
    fontSize: 12,
    color: "#cbd5e1",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  bubbleText: {
    color: "#f8fafc",
    lineHeight: 20,
  },
  composer: {
    gap: 8,
  },
  composerInput: {
    minHeight: 46,
    maxHeight: 120,
  },
});

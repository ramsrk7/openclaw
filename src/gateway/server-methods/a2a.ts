import {
  deliverA2aPushEnvelope,
  registerA2aPushTarget,
  unregisterA2aPushTarget,
} from "../../infra/a2a-push.js";
import { toA2aSessionKey } from "../a2a-context.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateA2aCancelParams,
  validateA2aPushRegisterParams,
  validateA2aPushUnregisterParams,
  validateA2aSendParams,
  validateA2aWaitParams,
} from "../protocol/index.js";
import { A2A_INLINE_FILE_MAX_BYTES } from "../protocol/schema/a2a.js";
import { agentHandlers } from "./agent.js";
import { chatHandlers } from "./chat.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

type A2aPart =
  | { type: "text"; text: string }
  | { type: "json"; value: unknown }
  | {
      type: "file";
      fileName?: string;
      contentType?: string;
      uri?: string;
      base64?: string;
    };

function estimateBase64Bytes(base64: string): number {
  const len = base64.length;
  if (len === 0) {
    return 0;
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

function buildAgentRequestFromA2aSend(params: {
  messageId: string;
  contextId: string;
  parts: A2aPart[];
  timeoutMs?: number;
  thinking?: string;
  lane?: string;
  channel?: string;
  accountId?: string;
  threadId?: string;
}) {
  const textParts: string[] = [];
  const attachments: Array<{
    type: "file";
    mimeType?: string;
    fileName?: string;
    content: string;
  }> = [];

  for (const part of params.parts) {
    if (part.type === "text") {
      textParts.push(part.text);
      continue;
    }
    if (part.type === "json") {
      textParts.push("```json\n" + JSON.stringify(part.value, null, 2) + "\n```");
      continue;
    }
    if (part.type === "file") {
      const uri = typeof part.uri === "string" ? part.uri.trim() : "";
      const base64 = typeof part.base64 === "string" ? part.base64.trim() : "";
      if (!uri && !base64) {
        throw new Error("file part must include uri or base64");
      }
      if (base64) {
        const estimatedBytes = estimateBase64Bytes(base64);
        if (estimatedBytes > A2A_INLINE_FILE_MAX_BYTES) {
          throw new Error(
            `inline file too large (${estimatedBytes} bytes), use uri mode for payloads over ${A2A_INLINE_FILE_MAX_BYTES} bytes`,
          );
        }
        attachments.push({
          type: "file",
          mimeType: part.contentType,
          fileName: part.fileName,
          content: base64,
        });
      } else {
        const fileName = part.fileName ?? "file";
        const mime = part.contentType ?? "application/octet-stream";
        textParts.push(`[File URI] name=${fileName} contentType=${mime} uri=${uri}`);
      }
    }
  }

  const message = textParts.join("\n\n").trim();
  if (!message && attachments.length === 0) {
    throw new Error("at least one text/json part or one file payload is required");
  }
  return {
    message,
    attachments: attachments.length > 0 ? attachments : undefined,
    sessionKey: toA2aSessionKey(params.contextId),
    idempotencyKey: params.messageId,
    timeout: params.timeoutMs,
    thinking: params.thinking,
    lane: params.lane,
    deliver: false,
    channel: params.channel,
    accountId: params.accountId,
    threadId: params.threadId,
  };
}

function forwardOnlyFirstResponse(params: {
  respond: RespondFn;
  mapPayload: (payload: unknown) => unknown;
}): RespondFn {
  let replied = false;
  return (ok, payload, error, meta) => {
    if (replied) {
      return;
    }
    replied = true;
    params.respond(ok, params.mapPayload(payload), error, meta);
  };
}

export const a2aHandlers: GatewayRequestHandlers = {
  "a2a.send": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!validateA2aSendParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid a2a.send params: ${formatValidationErrors(validateA2aSendParams.errors)}`,
        ),
      );
      return;
    }
    const request = params as {
      messageId: string;
      contextId: string;
      parts: A2aPart[];
      timeoutMs?: number;
      thinking?: string;
      lane?: string;
      channel?: string;
      accountId?: string;
      threadId?: string;
    };

    let agentParams: Record<string, unknown>;
    try {
      agentParams = buildAgentRequestFromA2aSend(request);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
      return;
    }

    await agentHandlers.agent({
      req,
      params: agentParams,
      context,
      client,
      isWebchatConnect,
      respond: forwardOnlyFirstResponse({
        respond,
        mapPayload: (payload) => {
          const runId =
            payload &&
            typeof payload === "object" &&
            typeof (payload as { runId?: unknown }).runId === "string"
              ? ((payload as { runId: string }).runId ?? request.messageId)
              : request.messageId;
          return {
            runId,
            taskId: runId,
            contextId: request.contextId,
            status: "accepted" as const,
            acceptedAt: Date.now(),
          };
        },
      }),
    });
  },
  "a2a.wait": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!validateA2aWaitParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid a2a.wait params: ${formatValidationErrors(validateA2aWaitParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { runId?: string; taskId?: string; timeoutMs?: number };
    const runId = (p.runId ?? p.taskId ?? "").trim();
    if (!runId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId or taskId is required"),
      );
      return;
    }

    await agentHandlers["agent.wait"]({
      req,
      params: { runId, timeoutMs: p.timeoutMs },
      context,
      client,
      isWebchatConnect,
      respond: (ok, payload, error, meta) => {
        if (!ok) {
          respond(false, undefined, error, meta);
          return;
        }
        const statusRaw =
          payload &&
          typeof payload === "object" &&
          typeof (payload as { status?: unknown }).status === "string"
            ? (payload as { status: string }).status
            : "timeout";
        const status =
          statusRaw === "ok"
            ? "completed"
            : statusRaw === "error"
              ? "failed"
              : statusRaw === "timeout"
                ? "timeout"
                : "cancelled";
        const obj = (payload ?? {}) as {
          startedAt?: number;
          endedAt?: number;
          error?: string;
        };
        respond(
          true,
          {
            runId,
            taskId: runId,
            status,
            startedAt: obj.startedAt,
            endedAt: obj.endedAt,
            error: obj.error,
          },
          undefined,
          meta,
        );
      },
    });
  },
  "a2a.cancel": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!validateA2aCancelParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid a2a.cancel params: ${formatValidationErrors(validateA2aCancelParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { runId?: string; contextId?: string; mode?: string };
    const mode = p.mode === "context" ? "context" : "run";
    const runId = (p.runId ?? "").trim();
    const contextId = (p.contextId ?? "").trim();
    const activeSessionKey =
      runId && context.chatAbortControllers.get(runId)?.sessionKey
        ? context.chatAbortControllers.get(runId)?.sessionKey
        : undefined;
    const sessionKey = activeSessionKey ?? (contextId ? toA2aSessionKey(contextId) : undefined);
    if (!sessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "contextId is required when runId is not active"),
      );
      return;
    }
    const chatAbortParams: { sessionKey: string; runId?: string } =
      mode === "context" ? { sessionKey } : { sessionKey, runId: runId || undefined };

    await chatHandlers["chat.abort"]({
      req,
      params: chatAbortParams,
      context,
      client,
      isWebchatConnect,
      respond,
    });
  },
  "a2a.push.register": ({ params, respond, context }) => {
    if (!validateA2aPushRegisterParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid a2a.push.register params: ${formatValidationErrors(validateA2aPushRegisterParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      clientId?: string;
      contextId?: string;
      sessionKey?: string;
      webhookUrl: string;
      authToken?: string;
      ttlMs?: number;
    };
    if (!p.clientId && !p.contextId && !p.sessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "clientId, contextId, or sessionKey is required"),
      );
      return;
    }
    const registration = registerA2aPushTarget({
      clientId: p.clientId,
      contextId: p.contextId,
      sessionKey: p.sessionKey,
      webhookUrl: p.webhookUrl,
      authToken: p.authToken,
      ttlMs: p.ttlMs,
    });
    context.logGateway.debug(
      `a2a.push.register registrationId=${registration.registrationId} contextId=${registration.contextId ?? ""}`,
    );
    respond(true, { ok: true, registrationId: registration.registrationId }, undefined);
  },
  "a2a.push.unregister": ({ params, respond }) => {
    if (!validateA2aPushUnregisterParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid a2a.push.unregister params: ${formatValidationErrors(validateA2aPushUnregisterParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      registrationId?: string;
      clientId?: string;
      contextId?: string;
      sessionKey?: string;
    };
    const removed = unregisterA2aPushTarget({
      registrationId: p.registrationId,
      clientId: p.clientId,
      contextId: p.contextId,
      sessionKey: p.sessionKey,
    });
    respond(true, { ok: true, removed }, undefined);
  },
  "a2a.push.test": async ({ params, respond, context }) => {
    const p = params as { contextId?: string; sessionKey?: string };
    const envelope = {
      kind: "status-update" as const,
      idempotencyKey: `a2a-push-test:${Date.now()}`,
      taskId: "a2a-push-test",
      runId: "a2a-push-test",
      contextId: p.contextId,
      status: { state: "working" as const },
      ts: Date.now(),
    };
    const result = await deliverA2aPushEnvelope({
      envelope,
      contextId: p.contextId,
      sessionKey: p.sessionKey,
      hasActiveWsRecipient: context.hasA2aEventClients,
    });
    respond(true, { ok: true, ...result }, undefined);
  },
};

import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const A2A_MAX_PARTS = 32;
export const A2A_INLINE_FILE_MAX_BYTES = 5_000_000;

export const A2aTextPartSchema = Type.Object(
  {
    type: Type.Literal("text"),
    text: Type.String(),
  },
  { additionalProperties: false },
);

export const A2aJsonPartSchema = Type.Object(
  {
    type: Type.Literal("json"),
    value: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const A2aFilePartSchema = Type.Object(
  {
    type: Type.Literal("file"),
    fileName: Type.Optional(NonEmptyString),
    contentType: Type.Optional(NonEmptyString),
    uri: Type.Optional(NonEmptyString),
    base64: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const A2aPartSchema = Type.Union([A2aTextPartSchema, A2aJsonPartSchema, A2aFilePartSchema]);

export const A2aSendParamsSchema = Type.Object(
  {
    kind: Type.Literal("message"),
    messageId: NonEmptyString,
    contextId: NonEmptyString,
    parts: Type.Array(A2aPartSchema, { minItems: 1, maxItems: A2A_MAX_PARTS }),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    thinking: Type.Optional(Type.String()),
    lane: Type.Optional(Type.String()),
    channel: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.String()),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const A2aSendResultSchema = Type.Object(
  {
    runId: NonEmptyString,
    taskId: NonEmptyString,
    contextId: NonEmptyString,
    status: Type.Literal("accepted"),
    acceptedAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const A2aWaitParamsSchema = Type.Object(
  {
    runId: Type.Optional(NonEmptyString),
    taskId: Type.Optional(NonEmptyString),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const A2aWaitResultSchema = Type.Object(
  {
    runId: NonEmptyString,
    taskId: NonEmptyString,
    status: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("timeout"),
      Type.Literal("cancelled"),
    ]),
    startedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    endedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    error: Type.Optional(Type.String()),
    finalText: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const A2aCancelParamsSchema = Type.Object(
  {
    runId: Type.Optional(NonEmptyString),
    contextId: Type.Optional(NonEmptyString),
    mode: Type.Optional(Type.String({ enum: ["run", "context"] })),
  },
  { additionalProperties: false },
);

export const A2aCancelResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    aborted: Type.Boolean(),
    runIds: Type.Array(NonEmptyString),
  },
  { additionalProperties: false },
);

export const A2aPushRegisterParamsSchema = Type.Object(
  {
    clientId: Type.Optional(NonEmptyString),
    contextId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
    webhookUrl: NonEmptyString,
    authToken: Type.Optional(Type.String()),
    ttlMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const A2aPushRegisterResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    registrationId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const A2aPushUnregisterParamsSchema = Type.Object(
  {
    registrationId: Type.Optional(NonEmptyString),
    clientId: Type.Optional(NonEmptyString),
    contextId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const A2aPushUnregisterResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    removed: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const A2aEventSchema = Type.Object(
  {
    type: Type.String({
      enum: ["a2a.task.status", "a2a.message.delta", "a2a.message.final", "a2a.artifact.update"],
    }),
    runId: NonEmptyString,
    taskId: NonEmptyString,
    contextId: Type.Optional(NonEmptyString),
    seq: Type.Integer({ minimum: 0 }),
    ts: Type.Integer({ minimum: 0 }),
    payload: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

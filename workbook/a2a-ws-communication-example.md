# A2A-over-WS Communication Example

This document shows a concrete client/server flow for the A2A-over-WebSocket contract implemented by gateway methods:

- `a2a.send`
- `a2a.wait`
- `a2a.cancel`
- `a2a.push.register`
- `a2a.push.unregister`

## 1) Connect and subscribe to events

Client opens one WebSocket connection and sends `connect` as usual. After `hello-ok`, it should handle:

- `event: "a2a"` for A2A task/message/artifact updates
- `event: "chat"` / `event: "agent"` only if the app also needs legacy contracts

## 2) Send a user message

Client request:

```json
{
  "type": "req",
  "id": "req-send-1",
  "method": "a2a.send",
  "params": {
    "kind": "message",
    "messageId": "msg_2026_03_01_001",
    "contextId": "thread_abc",
    "parts": [
      { "type": "text", "text": "Summarize this screenshot and tell me next steps." },
      {
        "type": "file",
        "fileName": "screen.png",
        "contentType": "image/png",
        "base64": "iVBORw0KGgoAAAANSUhEUgAA..."
      }
    ],
    "thinking": "low"
  }
}
```

Accepted response:

```json
{
  "type": "res",
  "id": "req-send-1",
  "ok": true,
  "payload": {
    "runId": "msg_2026_03_01_001",
    "taskId": "msg_2026_03_01_001",
    "contextId": "thread_abc",
    "status": "accepted",
    "acceptedAt": 1772382100123
  }
}
```

## 3) Stream updates from `event: "a2a"`

Example stream frames:

```json
{
  "type": "event",
  "event": "a2a",
  "payload": {
    "type": "a2a.task.status",
    "runId": "msg_2026_03_01_001",
    "taskId": "msg_2026_03_01_001",
    "contextId": "thread_abc",
    "seq": 3,
    "ts": 1772382100222,
    "payload": { "state": "working" }
  }
}
```

```json
{
  "type": "event",
  "event": "a2a",
  "payload": {
    "type": "a2a.message.delta",
    "runId": "msg_2026_03_01_001",
    "taskId": "msg_2026_03_01_001",
    "contextId": "thread_abc",
    "seq": 8,
    "ts": 1772382100350,
    "payload": { "text": "I can see a connection timeout dialog..." }
  }
}
```

```json
{
  "type": "event",
  "event": "a2a",
  "payload": {
    "type": "a2a.message.final",
    "runId": "msg_2026_03_01_001",
    "taskId": "msg_2026_03_01_001",
    "contextId": "thread_abc",
    "seq": 15,
    "ts": 1772382101020,
    "payload": { "text": "The app cannot reach the gateway. Next steps: ..." }
  }
}
```

## 4) Wait for terminal state

Client request:

```json
{
  "type": "req",
  "id": "req-wait-1",
  "method": "a2a.wait",
  "params": {
    "taskId": "msg_2026_03_01_001",
    "timeoutMs": 30000
  }
}
```

Terminal response:

```json
{
  "type": "res",
  "id": "req-wait-1",
  "ok": true,
  "payload": {
    "runId": "msg_2026_03_01_001",
    "taskId": "msg_2026_03_01_001",
    "status": "completed",
    "startedAt": 1772382100150,
    "endedAt": 1772382101010
  }
}
```

## 5) Cancel in-flight runs

Run-scoped cancel:

```json
{
  "type": "req",
  "id": "req-cancel-1",
  "method": "a2a.cancel",
  "params": {
    "runId": "msg_2026_03_01_001",
    "contextId": "thread_abc",
    "mode": "run"
  }
}
```

Context-wide cancel:

```json
{
  "type": "req",
  "id": "req-cancel-ctx-1",
  "method": "a2a.cancel",
  "params": {
    "contextId": "thread_abc",
    "mode": "context"
  }
}
```

## 6) Offline/background push flow

Register push target:

```json
{
  "type": "req",
  "id": "req-push-reg-1",
  "method": "a2a.push.register",
  "params": {
    "clientId": "ios-device-1",
    "contextId": "thread_abc",
    "webhookUrl": "https://example.app/push/openclaw",
    "authToken": "push_token_redacted",
    "ttlMs": 2592000000
  }
}
```

Unregister push target:

```json
{
  "type": "req",
  "id": "req-push-unreg-1",
  "method": "a2a.push.unregister",
  "params": {
    "clientId": "ios-device-1",
    "contextId": "thread_abc"
  }
}
```

Push payload shape received by webhook:

```json
{
  "kind": "status-update",
  "idempotencyKey": "msg_2026_03_01_001:15:end",
  "taskId": "msg_2026_03_01_001",
  "runId": "msg_2026_03_01_001",
  "contextId": "thread_abc",
  "status": { "state": "completed" },
  "ts": 1772382101020
}
```

## 7) Client de-duplication rules

Recommended client key:

- terminal/update dedupe key: `(taskId, idempotencyKey)`
- stream ordering key: `(taskId, seq)`

Recommended behavior:

- ignore duplicate terminal states with same `idempotencyKey`
- keep latest `seq` per `taskId`
- treat push and WS payloads as interchangeable envelopes (same dedupe key rules)

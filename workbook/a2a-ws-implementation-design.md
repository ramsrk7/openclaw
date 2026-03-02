---
summary: "Implementation design for A2A-style messaging over OpenClaw WebSocket gateway"
read_when:
  - You are building a web/mobile client that needs agent runs, streaming, and cancellation
  - You want A2A-compatible message/task semantics without changing transport to HTTP/SSE first
title: "A2A-over-WebSocket Implementation Design"
---

# A2A-over-WebSocket Implementation Design

## 1) Goal

Define and implement an **A2A-compatible messaging layer** on top of the existing OpenClaw **WebSocket gateway** so React web/mobile apps can:

- send user messages,
- receive streaming agent progress and final outputs,
- receive server push notifications when the app is offline/backgrounded (cron/subagent completions),
- cancel in-flight runs,
- support subagent/cron/normal flows consistently,
- and keep a migration path to full transport-level A2A later.

This design intentionally reuses existing OpenClaw runtime primitives (`agent`, `agent.wait`, `chat.abort`, `sessions.*`, agent events).

## 2) Decision

Use:

- **Transport:** existing OpenClaw Gateway WebSocket framing (`req`/`res`/`event`)
- **Payload protocol:** A2A-like message/task envelopes in method params/results/events

Do **not** replace gateway transport at this stage.

## 3) Scope and non-goals

### In scope

- New gateway method namespace for A2A over WS (for example `a2a.send`, `a2a.wait`, `a2a.cancel`)
- A2A-style envelope mapping:
  - user message -> run start
  - media/files (`FilePart`) -> run start and artifact propagation
  - lifecycle/tool updates -> task updates
  - final response -> completed task/message
- Client contract for React app (single WS connection, typed events)

### Out of scope (phase 1)

- Full A2A transport parity (HTTP+JSON, JSON-RPC, gRPC endpoints)
- Multi-server A2A federation/routing
- Full external push provider abstraction beyond one concrete gateway-managed path

## 4) Existing runtime we are building on

Current gateway/runtime capabilities already available:

- Run start: `agent` gateway method
- Run status wait: `agent.wait`
- Run abort: `chat.abort`
- Session operations: `sessions.*`
- Streaming runtime events: broadcast `"agent"` events with `stream` (`assistant`, `tool`, `lifecycle`, etc.)
- Tool-event recipient routing for WS clients with tool-events capability

This means we mostly need an adapter/protocol layer, not a new execution engine.

## 5) Protocol mapping (A2A semantics -> OpenClaw methods)

### 5.1 Inbound A2A-style request

Client sends (inside WS `req.params`):

- `kind: "message"`
- `messageId`
- `contextId` (maps to session key)
- `parts` (`TextPart`, `FilePart`, `JsonPart`; `FilePart` supports URI and inline base64 forms)
- optional client metadata

Gateway adapter maps to:

- `agent` method call
  - `message` <- joined text content + normalized file/media hints
  - `attachments/images` <- mapped from `FilePart` by MIME category
  - `sessionKey` <- derived from `contextId` mapping
  - `idempotencyKey` <- `messageId` (or deterministic derivation)
  - `deliver: false` for app-controlled rendering flow
  - optional `lane`, `thinking`, `threadId`, `channel/account` hints

Media/file support requirements (Phase 1):

- Accept **any file MIME type** in `FilePart` (do not hardcode allowlist in protocol adapter).
- Support both:
  - URI reference mode (preferred for large files),
  - inline base64 mode (bounded by payload size policy).
- For very large binary payloads, return a structured validation error instructing client to use URI mode.
- Preserve filename + contentType metadata end-to-end for downstream tools and UI rendering.

### 5.2 Streaming updates

OpenClaw runtime `"agent"` events map to A2A-style task/message updates:

- `stream: "lifecycle"` + `phase=start` -> task `submitted/working`
- `stream: "assistant"` deltas -> message partial/event stream
- `stream: "tool"` -> task artifact/status updates (configurable detail level)
- `stream: "lifecycle"` + `phase=end` -> task `completed`
- `stream: "lifecycle"` + `phase=error` -> task `failed`

### 5.3 Completion/wait

`a2a.wait` maps to `agent.wait` and returns:

- `status: completed|failed|timeout|cancelled`
- final message content and task metadata

### 5.4 Cancel

`a2a.cancel` maps to `chat.abort` using run/session context.

## 6) Proposed gateway interface

Add new methods in gateway method registry:

- `a2a.send`
- `a2a.wait`
- `a2a.cancel`
- (optional) `a2a.history`

Each method uses existing OpenClaw primitives internally.

### 6.1 `a2a.send`

Input:

- A2A-style message envelope (`messageId`, `contextId`, `parts`)
- options (`timeoutMs`, `thinking`, `lane`, `metadata`)

Output:

- accepted result with `runId`, `taskId`, `contextId`

### 6.2 `a2a.wait`

Input:

- `runId` or `taskId`, `timeoutMs`

Output:

- normalized terminal state and final message payload

### 6.3 `a2a.cancel`

Input:

- `runId` or `contextId`

Output:

- cancel accepted + run ids aborted

## 7) Session and identity model

Use a deterministic mapping:

- `contextId` <-> `sessionKey`
- `taskId` <-> `runId` (or a stable run alias)

Rules:

- repeat `contextId` continues same conversational session
- new `contextId` creates isolated thread/session
- subagent and cron sessions keep their existing internal keys; adapter emits normalized parent-visible identifiers

## 8) Event model for React clients

Emit new WS `"a2a"` event stream (adapter layer), produced from existing `"agent"` events:

- `a2a.task.status` (`submitted`, `working`, `completed`, `failed`, `cancelled`)
- `a2a.message.delta` (streaming text chunks)
- `a2a.message.final`
- `a2a.artifact.update` (tool/action outputs when enabled)

This avoids exposing raw internal event shapes directly to app clients and creates a stable contract.

## 8.1 Push notification model (included in Phase 1)

We include push in Phase 1 to guarantee delivery for:

- cron isolated run completions,
- subagent completion announcements,
- long-running tasks that finish after app disconnect.

### Push channels

- **Foreground / connected:** normal WS `"a2a"` events (primary path)
- **Background / disconnected:** server push event via registered client push target

### Proposed methods

- `a2a.push.register`
  - associates `clientId` and/or `contextId` with a push target and auth token metadata
- `a2a.push.unregister`
  - removes registration
- `a2a.push.test` (optional)
  - sends a probe notification for setup validation

### Push payload contract

Use A2A-style task update envelope:

- `kind`: `status-update` or `message`
- `taskId` / `contextId` / `runId`
- `status.state`: `working|completed|failed|cancelled`
- optional final text/artifact summary

### Delivery semantics

- At-least-once delivery with idempotency key per notification
- Client de-duplicates by `(taskId, sequence/idempotencyKey)`
- Retry with backoff on transient failures
- TTL expiration to avoid stale spam

## 9) Subagent and cron behavior in A2A view

### Subagents

- Keep existing spawn/orchestration internals.
- Parent-facing A2A stream receives:
  - intermediate task status updates,
  - child completion summaries as message/artifact updates,
  - final synthesized parent result as terminal message.

### Cron isolated runs

- Continue using `runCronIsolatedAgentTurn(...)` and delivery dispatch.
- For app-connected sessions:
  - expose cron result as A2A task updates if routed to the same session/context,
  - or as outbound channel-only delivery when run is not app-targeted.

## 10) Security and policy

Must preserve existing controls:

- auth and scope checks from gateway WS connect/auth layer
- session visibility checks from `sessions.*` behavior
- lane and delivery policy constraints
- input provenance passthrough when agent-to-agent/session-to-session sends occur

Additional adapter controls:

- strict envelope validation (schema)
- idempotency enforcement via `messageId`
- max payload and parts limits
- explicit redaction for tool outputs unless client capability allows full detail

## 11) Implementation plan

### Phase 1: Adapter MVP

1. Add `a2a` schemas under gateway protocol schema package
2. Implement `a2a.send` -> call existing `agent`
3. Implement `a2a.wait` -> call existing `agent.wait`
4. Implement `a2a.cancel` -> call existing `chat.abort`
5. Add `a2a` event broadcaster that transforms internal `"agent"` events
6. Implement push registration + delivery path for offline/background clients
7. Wire cron/subagent completion paths to emit push notifications when no active WS recipient
8. Add integration tests for accepted/stream/final/cancel/error/push

### Phase 2: Rich task/artifact semantics

1. Normalize tool events into artifact updates
2. Add optional event verbosity levels
3. Add context/task history method

### Phase 3: Optional full A2A transport endpoints

1. Add HTTP/JSON-RPC or gRPC front door
2. Reuse same adapter core used by WS methods
3. Conformance and interoperability tests

## 12) File-level change plan

Likely touch points:

- `src/gateway/protocol/schema/*` (new A2A request/response/event schemas)
- `src/gateway/server-methods/*` (new `a2a` handlers)
- `src/gateway/server-methods-list.ts` (register methods)
- `src/gateway/server-chat.ts` (event mapping hook for `a2a` event stream)
- `src/gateway/server-methods/agent.ts` (shared helper extraction if needed)
- tests in `src/gateway/*test.ts`

## 13) Testing strategy

### Unit

- schema validation
- mapping correctness (`contextId`/`taskId`/`runId`)
- lifecycle state mapping (`start/end/error/timeout/abort`)

### Integration

- `a2a.send` -> streamed deltas -> final completion
- `a2a.send` with `FilePart` (URI and base64) -> run executes and returns valid final/task updates
- cancel during stream
- tool-heavy turn emits artifacts
- idempotency replay returns same accepted result
- cron completion triggers push when client disconnected
- subagent completion triggers push when requester client disconnected

### Regression

- normal chat/gateway behavior unaffected
- subagent and cron flows still deliver as before
- tool event visibility policy unchanged for non-A2A clients

## 14) Risks and mitigations

- **Risk:** dual event contracts (`agent` + `a2a`) diverge
  - **Mitigation:** implement single internal mapping utility and test against snapshots.
- **Risk:** overexposing tool internals to client
  - **Mitigation:** default redaction, capability-gated full output.
- **Risk:** ambiguous session mapping across channels
  - **Mitigation:** explicit `contextId` mapping table and deterministic normalization.
- **Risk:** duplicate WS + push user-visible notifications
  - **Mitigation:** notification idempotency key and client-side collapse by task/run id.
- **Risk:** push retries amplify stale events
  - **Mitigation:** per-event TTL + terminal-state suppression once acknowledged.

## 15) Decision log (resolved)

- **Media parts in Phase 1:** Yes.
  - `a2a.send` supports `TextPart`, `FilePart`, and `JsonPart` now.
  - `FilePart` accepts URI and inline base64; any MIME type is allowed at protocol layer.
- **`taskId` mapping:** use `taskId == runId` in Phase 1.
  - Keep mapping centralized so we can decouple later without client contract break.
- **Subagent child visibility:** default to summarized artifacts/events in parent task stream.
  - Do not expose full nested child task trees by default in Phase 1.
- **Cancellation scope:** support both, with explicit mode.
  - Default: run-scoped cancel (`runId`).
  - Optional: context-wide cancel for all active runs in `contextId`.
- **Phase 1 push target:** canonical server push webhook contract.
  - Browser/mobile push providers (Web Push/APNs/FCM) are integrated behind app backend/webhook bridge.
  - Keeps gateway protocol provider-agnostic while still supporting offline delivery.

## 16) Recommended immediate next step

Implement Phase 1 with a minimal, stable contract:

- one send method,
- one wait method,
- one cancel method,
- one event stream,
- one push registration/delivery path.

Then build the React SDK wrapper over that contract.

## 17) External references

- A2A Part model: <https://agent2agent.info/docs/concepts/part/>
- A2A Artifact model: <https://agent2agent.info/docs/concepts/artifact/>
- A2A specification: <https://google.github.io/A2A/specification/>
- A2A JS SDK: <https://github.com/a2aproject/a2a-js>

## 18) Companion communication examples

- See `workbook/a2a-ws-communication-example.md` for concrete WS request/response/event flows and push webhook payload examples.

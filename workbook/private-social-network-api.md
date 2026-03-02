---
summary: "API appendix for Private Social Network methods and notify/no-op delivery behavior"
read_when:
  - You are implementing social.* gateway methods
  - You need request/response shapes before coding
  - You need exact test targets in Forked/openclaw
title: "Private Social Network API Appendix"
---

# Private Social Network API Appendix

## 1) Method contract summary

| Method                     | Purpose                         | Write/Read |
| -------------------------- | ------------------------------- | ---------- |
| `social.user.pair.request` | Issue pairing code              | write      |
| `social.user.join`         | Join/register with pairing code | write      |
| `social.user.list`         | List visible users              | read       |
| `social.session.bind`      | Bind session to user            | write      |
| `social.dm.send`           | Relay message to another user   | write      |
| `social.feed.post`         | Create post                     | write      |
| `social.feed.like`         | Like/unlike post                | write      |
| `social.feed.comment`      | Add comment                     | write      |
| `social.feed.list`         | Read feed                       | read       |

## 2) Example request/response shapes

## `social.user.join`

Request:

```json
{
  "pairingCode": "FAM-9X3K-42",
  "displayName": "Alice",
  "sessionKey": "agent:main:telegram:direct:@alice",
  "handles": {
    "telegram": "@alice"
  }
}
```

Response:

```json
{
  "ok": true,
  "user": {
    "userId": "usr_01",
    "familyId": "fam_home_01",
    "displayName": "Alice"
  }
}
```

## `social.dm.send`

Request:

```json
{
  "fromUserId": "usr_01",
  "toUserId": "usr_02",
  "text": "Can you pick up milk?"
}
```

Response:

```json
{
  "ok": true,
  "delivery": {
    "status": "sent",
    "channel": "telegram",
    "target": "@bob",
    "messageId": "msg_01"
  }
}
```

## `social.feed.post`

Request:

```json
{
  "authorUserId": "usr_01",
  "text": "Family movie night on Friday?"
}
```

Response:

```json
{
  "ok": true,
  "post": {
    "postId": "pst_01",
    "authorUserId": "usr_01",
    "text": "Family movie night on Friday?"
  }
}
```

## 3) Cron/custom notify no-op delivery contract

Use a structured delivery outcome instead of user-visible terse text.

### Delivery status shape

```json
{
  "delivery": {
    "status": "sent | noop | failed",
    "reason": "duplicate_or_no_target | explicit_silent_token | transport_error",
    "targetSessionKey": "agent:main:telegram:direct:123",
    "messageId": "optional-when-sent"
  }
}
```

### Behavior rules

- If output is equivalent to silent token, emit `status="noop"` and do not surface the text.
- If target is missing or duplicate in this notify branch, emit `status="noop"` with reason.
- If outbound send succeeds, emit `status="sent"`.
- If outbound send fails and best-effort is disabled, emit `status="failed"` and fail the run.

## 4) Phase-2 implementation checklist (fork only)

### Backend files

- `src/gateway/server-methods.ts`
- `src/gateway/server-methods-list.ts`
- `src/gateway/method-scopes.ts`
- `src/gateway/protocol/index.ts`
- `src/gateway/protocol/schema.ts`
- `src/gateway/protocol/schema/protocol-schemas.ts`
- `src/gateway/protocol/schema/types.ts`
- `src/agents/subagent-announce.ts` (silent/noop handling policy updates)
- `src/cron/isolated-agent/delivery-dispatch.ts` (structured no-op delivery emission)
- new `src/gateway/server-methods/social.ts`
- new `src/gateway/protocol/schema/social.ts`
- new `src/infra/social-store.ts`

### UI files

- `ui/src/ui/navigation.ts`
- `ui/src/ui/app.ts`
- `ui/src/ui/app-view-state.ts`
- `ui/src/ui/app-render.ts`
- `ui/src/ui/app-render.helpers.ts`
- `ui/src/ui/controllers/chat.ts`
- `ui/src/ui/views/instances.ts`
- `ui/src/ui/controllers/presence.ts`
- new `ui/src/ui/views/social.ts`
- new `ui/src/ui/controllers/social.ts`

### Test files

- `src/gateway/protocol/index.test.ts`
- `src/gateway/method-scopes.test.ts`
- `src/cron/isolated-agent.skips-delivery-without-whatsapp-recipient-besteffortdeliver-true.test.ts`
- new `src/gateway/server-methods/social.test.ts`
- new `src/infra/social-store.test.ts`
- `ui/src/ui/navigation.test.ts`
- `ui/src/ui/app-settings.test.ts`
- `ui/src/ui/controllers/chat.test.ts`
- new `ui/src/ui/controllers/social.test.ts`
- new `ui/src/ui/views/social.test.ts`

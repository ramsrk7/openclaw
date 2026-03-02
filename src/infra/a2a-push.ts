import { randomUUID } from "node:crypto";

type A2aPushRegistrationInput = {
  registrationId?: string;
  clientId?: string;
  contextId?: string;
  sessionKey?: string;
  webhookUrl: string;
  authToken?: string;
  ttlMs?: number;
};

export type A2aPushRegistration = {
  registrationId: string;
  clientId?: string;
  contextId?: string;
  sessionKey?: string;
  webhookUrl: string;
  authToken?: string;
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type A2aPushEnvelope = {
  kind: "status-update" | "message";
  idempotencyKey: string;
  taskId: string;
  runId: string;
  contextId?: string;
  status?: { state: "working" | "completed" | "failed" | "cancelled" };
  message?: { type: "delta" | "final"; text?: string };
  artifact?: Record<string, unknown>;
  ts: number;
};

const registrations = new Map<string, A2aPushRegistration>();
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_EVENT_TTL_MS = 10 * 60 * 1000;
const RETRY_DELAYS_MS = [200, 1000, 3000] as const;

function pruneExpiredRegistrations(now = Date.now()) {
  for (const [id, reg] of registrations) {
    if (typeof reg.expiresAt === "number" && reg.expiresAt <= now) {
      registrations.delete(id);
    }
  }
}

function normalizeOptional(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function registerA2aPushTarget(input: A2aPushRegistrationInput): A2aPushRegistration {
  const now = Date.now();
  pruneExpiredRegistrations(now);
  const registrationId = normalizeOptional(input.registrationId) ?? randomUUID();
  const ttlMs = Math.max(1, Math.floor(input.ttlMs ?? DEFAULT_TTL_MS));
  const existing = registrations.get(registrationId);
  const next: A2aPushRegistration = {
    registrationId,
    clientId: normalizeOptional(input.clientId),
    contextId: normalizeOptional(input.contextId),
    sessionKey: normalizeOptional(input.sessionKey),
    webhookUrl: input.webhookUrl.trim(),
    authToken: normalizeOptional(input.authToken),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    expiresAt: now + ttlMs,
  };
  registrations.set(registrationId, next);
  return next;
}

export function unregisterA2aPushTarget(params: {
  registrationId?: string;
  clientId?: string;
  contextId?: string;
  sessionKey?: string;
}): number {
  pruneExpiredRegistrations();
  const registrationId = normalizeOptional(params.registrationId);
  if (registrationId) {
    return registrations.delete(registrationId) ? 1 : 0;
  }

  const clientId = normalizeOptional(params.clientId);
  const contextId = normalizeOptional(params.contextId);
  const sessionKey = normalizeOptional(params.sessionKey);
  let removed = 0;
  for (const [id, reg] of registrations) {
    if (clientId && reg.clientId !== clientId) {
      continue;
    }
    if (contextId && reg.contextId !== contextId) {
      continue;
    }
    if (sessionKey && reg.sessionKey !== sessionKey) {
      continue;
    }
    registrations.delete(id);
    removed += 1;
  }
  return removed;
}

function matchesRegistration(
  reg: A2aPushRegistration,
  params: { clientId?: string; contextId?: string; sessionKey?: string },
): boolean {
  if (params.clientId && reg.clientId === params.clientId) {
    return true;
  }
  if (params.contextId && reg.contextId === params.contextId) {
    return true;
  }
  if (params.sessionKey && reg.sessionKey === params.sessionKey) {
    return true;
  }
  return false;
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliverToRegistration(
  reg: A2aPushRegistration,
  envelope: A2aPushEnvelope,
): Promise<boolean> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (reg.authToken) {
        headers.authorization = `Bearer ${reg.authToken}`;
      }
      const response = await fetch(reg.webhookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(envelope),
      });
      if (response.ok) {
        return true;
      }
      if (response.status >= 400 && response.status < 500) {
        return false;
      }
    } catch {
      // Retry below.
    }
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay != null) {
      await sleepMs(delay);
    }
  }
  return false;
}

export async function deliverA2aPushEnvelope(params: {
  envelope: A2aPushEnvelope;
  clientId?: string;
  contextId?: string;
  sessionKey?: string;
  eventTtlMs?: number;
  hasActiveWsRecipient?: () => boolean;
}): Promise<{ attempted: number; delivered: number; skipped: boolean }> {
  const now = Date.now();
  pruneExpiredRegistrations(now);
  const eventTtlMs = Math.max(1, Math.floor(params.eventTtlMs ?? DEFAULT_EVENT_TTL_MS));
  if (now - params.envelope.ts > eventTtlMs) {
    return { attempted: 0, delivered: 0, skipped: true };
  }
  if (params.hasActiveWsRecipient?.()) {
    return { attempted: 0, delivered: 0, skipped: true };
  }

  const clientId = normalizeOptional(params.clientId);
  const contextId = normalizeOptional(params.contextId);
  const sessionKey = normalizeOptional(params.sessionKey);
  const targets = Array.from(registrations.values()).filter((reg) =>
    matchesRegistration(reg, { clientId, contextId, sessionKey }),
  );
  if (targets.length === 0) {
    return { attempted: 0, delivered: 0, skipped: false };
  }

  let delivered = 0;
  for (const target of targets) {
    if (await deliverToRegistration(target, params.envelope)) {
      delivered += 1;
    }
  }
  return { attempted: targets.length, delivered, skipped: false };
}

export function resetA2aPushRegistryForTest(): void {
  registrations.clear();
}

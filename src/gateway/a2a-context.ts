const A2A_SESSION_PREFIX = "agent:main:a2a:ctx:";

export function toA2aSessionKey(contextId: string): string {
  const encoded = Buffer.from(contextId, "utf8").toString("base64url");
  return `${A2A_SESSION_PREFIX}${encoded}`;
}

export function contextIdFromA2aSessionKey(sessionKey?: string): string | undefined {
  if (typeof sessionKey !== "string" || !sessionKey.startsWith(A2A_SESSION_PREFIX)) {
    return undefined;
  }
  const encoded = sessionKey.slice(A2A_SESSION_PREFIX.length).trim();
  if (!encoded) {
    return undefined;
  }
  try {
    const decodedBuffer = Buffer.from(encoded, "base64url");
    const decoded = decodedBuffer.toString("utf8");
    // Guard against invalid UTF-8 decode artifacts. If a decoded value does not
    // round-trip to the same base64url payload, treat it as malformed.
    if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded) {
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
}

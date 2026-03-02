import { describe, expect, it, beforeEach, vi } from "vitest";
import { resetA2aPushRegistryForTest } from "../../infra/a2a-push.js";
import { a2aHandlers } from "./a2a.js";

function createBaseArgs() {
  return {
    req: { id: "req-1", type: "req", method: "a2a.push.register" },
    client: null,
    isWebchatConnect: () => false,
    context: {
      logGateway: {
        debug: vi.fn(),
      },
      chatAbortControllers: new Map(),
      hasA2aEventClients: () => false,
    },
  };
}

describe("a2a handlers", () => {
  beforeEach(() => {
    resetA2aPushRegistryForTest();
  });

  it("registers and unregisters push targets", async () => {
    const respond = vi.fn();
    const args = createBaseArgs();
    await a2aHandlers["a2a.push.register"]({
      ...args,
      respond,
      params: {
        contextId: "ctx-1",
        webhookUrl: "https://example.com/push",
      },
    } as never);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
      }),
      undefined,
    );
    const registrationId = (respond.mock.calls[0]?.[1] as { registrationId?: string })
      ?.registrationId;
    expect(registrationId).toBeTruthy();

    const unregisterRespond = vi.fn();
    await a2aHandlers["a2a.push.unregister"]({
      ...args,
      respond: unregisterRespond,
      params: {
        registrationId,
      },
    } as never);
    expect(unregisterRespond).toHaveBeenCalledWith(true, { ok: true, removed: 1 }, undefined);
  });

  it("rejects push register with no routing key", async () => {
    const respond = vi.fn();
    const args = createBaseArgs();
    await a2aHandlers["a2a.push.register"]({
      ...args,
      respond,
      params: {
        webhookUrl: "https://example.com/push",
      },
    } as never);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
      }),
    );
  });

  it("rejects wait request when run id and task id are missing", async () => {
    const respond = vi.fn();
    const args = createBaseArgs();
    await a2aHandlers["a2a.wait"]({
      ...args,
      respond,
      params: {},
      req: { id: "req-2", type: "req", method: "a2a.wait" },
    } as never);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
      }),
    );
  });
});

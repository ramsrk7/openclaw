import type { ErrorObject } from "ajv";
import { describe, expect, it } from "vitest";
import { formatValidationErrors, validateA2aSendParams } from "./index.js";

const makeError = (overrides: Partial<ErrorObject>): ErrorObject => ({
  keyword: "type",
  instancePath: "",
  schemaPath: "#/",
  params: {},
  message: "validation error",
  ...overrides,
});

describe("A2A validators", () => {
  it("accepts valid a2a.send params with mixed parts", () => {
    const valid = validateA2aSendParams({
      kind: "message",
      messageId: "msg-1",
      contextId: "ctx-1",
      parts: [
        { type: "text", text: "hello" },
        { type: "json", value: { foo: "bar" } },
        {
          type: "file",
          fileName: "a.png",
          contentType: "image/png",
          base64: "Zm9v",
        },
      ],
    });
    expect(valid).toBe(true);
  });

  it("rejects a2a.send params with unknown top-level field", () => {
    const valid = validateA2aSendParams({
      kind: "message",
      messageId: "msg-1",
      contextId: "ctx-1",
      parts: [{ type: "text", text: "hello" }],
      unknownField: true,
    });
    expect(valid).toBe(false);
  });
});

describe("formatValidationErrors", () => {
  it("returns unknown validation error when missing errors", () => {
    expect(formatValidationErrors(undefined)).toBe("unknown validation error");
    expect(formatValidationErrors(null)).toBe("unknown validation error");
  });

  it("returns unknown validation error when errors list is empty", () => {
    expect(formatValidationErrors([])).toBe("unknown validation error");
  });

  it("formats additionalProperties at root", () => {
    const err = makeError({
      keyword: "additionalProperties",
      params: { additionalProperty: "token" },
    });

    expect(formatValidationErrors([err])).toBe("at root: unexpected property 'token'");
  });

  it("formats additionalProperties with instancePath", () => {
    const err = makeError({
      keyword: "additionalProperties",
      instancePath: "/auth",
      params: { additionalProperty: "token" },
    });

    expect(formatValidationErrors([err])).toBe("at /auth: unexpected property 'token'");
  });

  it("formats message with path for other errors", () => {
    const err = makeError({
      keyword: "required",
      instancePath: "/auth",
      message: "must have required property 'token'",
    });

    expect(formatValidationErrors([err])).toBe("at /auth: must have required property 'token'");
  });

  it("de-dupes repeated entries", () => {
    const err = makeError({
      keyword: "required",
      instancePath: "/auth",
      message: "must have required property 'token'",
    });

    expect(formatValidationErrors([err, err])).toBe(
      "at /auth: must have required property 'token'",
    );
  });
});

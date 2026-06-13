import { describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";

vi.mock("@grpc/grpc-js", () => ({
  status: {
    INVALID_ARGUMENT: 3,
    DEADLINE_EXCEEDED: 4,
    RESOURCE_EXHAUSTED: 8,
    INTERNAL: 13,
    UNAVAILABLE: 14,
  },
}));

import {
  QueueFullError,
  RequestTimeoutError,
  ServerDrainingError,
  ServerUnavailableError,
  toServiceError,
} from "./errors.js";

describe("Connection-server errors — property tests", () => {
  it("Property 12: server-side errors map to the correct gRPC status and structured ErrorDetail", async () => {
    const caseArb = fc.record({
      kind: fc.constantFrom(
        "server_unavailable" as const,
        "request_timeout" as const,
        "queue_full" as const,
        "server_draining" as const,
        "invalid_argument" as const,
        "internal" as const,
      ),
      message: fc.string({ minLength: 1, maxLength: 40 }),
      number: fc.integer({ min: 1, max: 1_000 }),
    });

    await fc.assert(
      fc.property(caseArb, ({ kind, message, number }) => {
        const { error, expectedCode, expectedDetailCode, retryable } = buildCase(
          kind,
          message,
          number,
        );

        const serviceError = toServiceError(error);
        const detail = JSON.parse(serviceError.details);

        expect(serviceError.code).toBe(expectedCode);
        expect(detail).toEqual({
          code: expectedDetailCode,
          message: error instanceof Error ? error.message : String(error),
          retryable,
        });
      }),
      { numRuns: 40 },
    );
  });
});

function buildCase(
  kind: "server_unavailable" | "request_timeout" | "queue_full" | "server_draining" | "invalid_argument" | "internal",
  message: string,
  number: number,
): {
  readonly error: unknown;
  readonly expectedCode: number;
  readonly expectedDetailCode: string;
  readonly retryable: boolean;
} {
  switch (kind) {
    case "server_unavailable":
      return {
        error: new ServerUnavailableError(`grpc://127.0.0.1:${number}`),
        expectedCode: 14,
        expectedDetailCode: "SERVER_UNAVAILABLE",
        retryable: true,
      };
    case "request_timeout":
      return {
        error: new RequestTimeoutError(`req-${number}`, number),
        expectedCode: 4,
        expectedDetailCode: "REQUEST_TIMEOUT",
        retryable: true,
      };
    case "queue_full":
      return {
        error: new QueueFullError(number),
        expectedCode: 8,
        expectedDetailCode: "QUEUE_FULL",
        retryable: true,
      };
    case "server_draining":
      return {
        error: new ServerDrainingError(),
        expectedCode: 14,
        expectedDetailCode: "SERVER_DRAINING",
        retryable: true,
      };
    case "invalid_argument":
      return {
        error: Object.assign(new Error(message), {
          code: 3,
          errorCode: "INVALID_ARGUMENT",
          retryable: false,
        }),
        expectedCode: 3,
        expectedDetailCode: "INVALID_ARGUMENT",
        retryable: false,
      };
    case "internal":
      return {
        error: new Error(message),
        expectedCode: 13,
        expectedDetailCode: "INTERNAL_ERROR",
        retryable: false,
      };
  }
}

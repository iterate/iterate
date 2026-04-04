/**
 * Curlability regression tests for the raw HTTP append endpoint.
 *
 * These cases are intentionally about raw HTTP ergonomics rather than the
 * typed oRPC client. The public append contract is `{ path, event }` in
 * `apps/events-contract/src/orpc-contract.ts`.
 *
 * The raw route in `apps/events/src/routes/api.$.ts` keeps curl ergonomics by:
 * - rewriting `/api/streams/` and `/api/streams//` to the canonical root path
 * - wrapping a naked JSON event body into `{ event: ... }` when the body has a
 *   top-level `type` and no top-level `event`
 *
 * Invalid event bodies are still normalized into `invalid-event-appended` at
 * the append contract boundary in `apps/events-contract/src/orpc-contract.ts`.
 *
 * These tests also pin the curlable path edge cases:
 * - root should be addressable as `/api/streams/`, `/api/streams//`, and `/api/streams/%2F`
 * - deeper paths should work both as raw nested segments and `%2F`-escaped forms
 *
 * The tests stay table-driven on purpose. The only dimensions are:
 * - path form
 * - payload shape
 * - expected status
 * - expected response matcher
 */
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  StreamPath,
  type JSONObject,
  type StreamPath as StreamPathType,
} from "@iterate-com/events-contract";
import { createEvents2AppFixture, requireEventsBaseUrl } from "../helpers.ts";

const app = createEvents2AppFixture({
  baseURL: requireEventsBaseUrl(),
});
const testTimeoutMs = 5_000;

const typeOnlyEvent = {
  type: "https://events.iterate.com/events/example/no-payload",
} satisfies JSONObject;

const validEvent = {
  type: "https://events.iterate.com/events/example/value-recorded",
  payload: {
    curlable: true,
  },
} satisfies JSONObject;

const invalidEvent = {
  type: "https://events.iterate.com/events/example/value-recorded",
  payload: "not-an-object",
} satisfies JSONObject;

const validNestedEvent = {
  event: validEvent,
} satisfies JSONObject;

const invalidNestedEvent = {
  event: invalidEvent,
} satisfies JSONObject;

type PathCase = {
  label: string;
  buildTarget: () => {
    appendPath: string;
    canonicalPath: StreamPathType;
  };
};

type PayloadCase = {
  label: string;
  body: JSONObject;
  expectedStatus: number;
  expectedResponse: (canonicalPath: StreamPathType) => unknown;
};

const rootPathCases = [
  {
    label: "root via trailing slash",
    buildTarget: () => ({
      appendPath: "/api/streams/",
      canonicalPath: "/" as StreamPathType,
    }),
  },
  {
    label: "root via double slash",
    buildTarget: () => ({
      appendPath: "/api/streams//",
      canonicalPath: "/" as StreamPathType,
    }),
  },
  {
    label: "root via escaped slash",
    buildTarget: () => ({
      appendPath: "/api/streams/%2F",
      canonicalPath: "/" as StreamPathType,
    }),
  },
] satisfies readonly PathCase[];

const nestedPathCases = [
  {
    label: "nested path via raw segments",
    buildTarget: () => {
      const partA = randomUUID().slice(0, 6);
      const partB = randomUUID().slice(0, 6);
      const canonicalPath = StreamPath.parse(`/e2e-curlability/${partA}/${partB}`);

      return {
        appendPath: `/api/streams${canonicalPath}`,
        canonicalPath,
      };
    },
  },
  {
    label: "nested path via escaped slashes",
    buildTarget: () => {
      const partA = randomUUID().slice(0, 6);
      const partB = randomUUID().slice(0, 6);
      const canonicalPath = StreamPath.parse(`/e2e-curlability/${partA}/${partB}`);

      return {
        appendPath: `/api/streams/${canonicalPath.slice(1).replaceAll("/", "%2F")}`,
        canonicalPath,
      };
    },
  },
] satisfies readonly PathCase[];

const payloadCases = [
  {
    label: "type-only bare event body (no payload field)",
    body: typeOnlyEvent,
    expectedStatus: 200,
    expectedResponse: (canonicalPath) => ({
      event: {
        streamPath: canonicalPath,
        type: typeOnlyEvent.type,
        payload: {},
      },
    }),
  },
  {
    label: "valid bare event body",
    body: validEvent,
    expectedStatus: 200,
    expectedResponse: (canonicalPath) => ({
      event: {
        streamPath: canonicalPath,
        type: validEvent.type,
        payload: validEvent.payload,
      },
    }),
  },
  {
    label: "valid nested event body",
    body: validNestedEvent,
    expectedStatus: 200,
    expectedResponse: (canonicalPath) => ({
      event: {
        streamPath: canonicalPath,
        type: validEvent.type,
        payload: validEvent.payload,
      },
    }),
  },
  {
    label: "invalid bare event body",
    body: invalidEvent,
    expectedStatus: 200,
    expectedResponse: (canonicalPath) => ({
      event: {
        streamPath: canonicalPath,
        type: "https://events.iterate.com/events/stream/invalid-event-appended",
        payload: {
          rawInput: invalidEvent,
          error: expect.stringContaining("payload"),
        },
      },
    }),
  },
  {
    label: "invalid nested event body",
    body: invalidNestedEvent,
    expectedStatus: 200,
    expectedResponse: (canonicalPath) => ({
      event: {
        streamPath: canonicalPath,
        type: "https://events.iterate.com/events/stream/invalid-event-appended",
        payload: {
          rawInput: invalidEvent,
          error: expect.stringContaining("payload"),
        },
      },
    }),
  },
] satisfies readonly PayloadCase[];

const cases = [...rootPathCases, ...nestedPathCases].flatMap((pathCase) =>
  payloadCases.map((payloadCase) => ({
    pathLabel: pathCase.label,
    payloadLabel: payloadCase.label,
    buildTarget: pathCase.buildTarget,
    body: payloadCase.body,
    expectedStatus: payloadCase.expectedStatus,
    expectedResponse: payloadCase.expectedResponse,
  })),
);

describe.sequential("events curlability e2e", () => {
  test.each(cases)(
    "$pathLabel · $payloadLabel",
    async (testCase) => {
      const target = testCase.buildTarget();

      const response = await app.fetch(target.appendPath, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(testCase.body),
      });

      expect(response.status).toBe(testCase.expectedStatus);
      await expect(response.json()).resolves.toMatchObject(
        testCase.expectedResponse(target.canonicalPath),
      );

      const stateResponse = await app.fetch(canonicalStatePath(target.canonicalPath));
      expect(stateResponse.status).toBe(200);
      await expect(stateResponse.json()).resolves.toMatchObject({
        path: target.canonicalPath,
      });
    },
    testTimeoutMs,
  );
});

function canonicalStatePath(path: StreamPathType) {
  if (path === "/") {
    return "/api/__state/%2F";
  }

  return `/api/__state/${path.slice(1).replaceAll("/", "%2F")}`;
}

/**
 * Same curls as below, runnable in a terminal after:
 *   export BASE_URL="http://127.0.0.1:5174"
 *   export STREAM_CURL_PATH="e2e-curl/xxxxxxxx"
 *   export STREAM_RPATH="%2Fe2e-curl%2Fxxxxxxxx"   # same path URL-encoded
 *
 *   curl -sS -X POST "$BASE_URL/api/streams/$STREAM_CURL_PATH" \
 *     -H 'content-type: application/json' \
 *     -d '{"type":"https://events.iterate.com/events/example/value-recorded","payload":{"curl":true}}'
 *   echo
 *   echo '---'
 *   curl -sS "$BASE_URL/api/streams/__state/$STREAM_CURL_PATH"
 *   echo
 *   echo '---'
 *   curl -sS "$BASE_URL/api/streams/__state/$STREAM_RPATH"
 *   echo
 *   echo '---'
 *   curl -sS -N "$BASE_URL/api/streams/$STREAM_CURL_PATH"
 *   echo
 *   echo '---'
 *   curl -sS "$BASE_URL/api/streams/__children/%2F" >/dev/null
 *   curl -sS "$BASE_URL/api/streams/__state/%2F" >/dev/null
 *
 * Test run: `EVENTS_BASE_URL` matches `BASE_URL` (no trailing slash).
 */
import { randomUUID } from "node:crypto";
import { StreamPath } from "@iterate-com/events-contract";
import { x } from "tinyexec";
import { describe, expect, test } from "vitest";
import { defaultE2EProjectSlug } from "../helpers.ts";

describe("events curl smoke", () => {
  test("append, state, history stream, and root endpoints (shell + snapshot)", async () => {
    const baseURL = process.env.EVENTS_BASE_URL?.trim().replace(/\/+$/, "");
    if (!baseURL) {
      throw new Error(
        "EVENTS_BASE_URL is required. Example: EVENTS_BASE_URL=http://127.0.0.1:5174 pnpm test:e2e",
      );
    }

    const streamPath = StreamPath.parse(`/e2e-curl/${randomUUID().slice(0, 8)}`);
    const streamCurlPath = streamPath.slice(1);
    const streamRpath = encodeURIComponent(streamPath);

    const script = `
set -euo pipefail

retry_json_get() {
  local url="$1"
  shift
  local body=""

  for _ in 1 2 3 4 5; do
    body="$(curl -sS "$url" "$@")"
    if [[ "$body" == \\{* ]]; then
      printf '%s' "$body"
      return 0
    fi
    sleep 0.2
  done

  printf '%s' "$body"
  return 1
}

curl -sS -X POST "$BASE_URL/api/streams/$STREAM_CURL_PATH" \\
  -H 'content-type: application/json' \\
  -H "x-iterate-project: $PROJECT_SLUG" \\
  -d '{"type":"https://events.iterate.com/events/example/value-recorded","payload":{"curl":true}}'
echo
echo '---'
retry_json_get "$BASE_URL/api/streams/__state/$STREAM_CURL_PATH" -H "x-iterate-project: $PROJECT_SLUG"
echo
echo '---'
retry_json_get "$BASE_URL/api/streams/__state/$STREAM_RPATH" -H "x-iterate-project: $PROJECT_SLUG"
echo
echo '---'
curl -sS -N "$BASE_URL/api/streams/$STREAM_CURL_PATH" -H "x-iterate-project: $PROJECT_SLUG"
echo
echo '---'
curl -sS "$BASE_URL/api/streams/__children/%2F" -H "x-iterate-project: $PROJECT_SLUG" >/dev/null
curl -sS "$BASE_URL/api/streams/__state/%2F" -H "x-iterate-project: $PROJECT_SLUG" >/dev/null
`;

    const result = await x("bash", ["-lc", script], {
      throwOnError: false,
      nodeOptions: {
        stdio: "pipe",
        env: {
          ...process.env,
          BASE_URL: baseURL,
          PROJECT_SLUG: defaultE2EProjectSlug,
          STREAM_CURL_PATH: streamCurlPath,
          STREAM_RPATH: streamRpath,
        },
      },
    });

    expect(result.exitCode).toBe(0);

    const stdout = result.stdout
      .replaceAll("\r\n", "\n")
      .replaceAll(streamPath, "<streamPath>")
      .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, "<ts>")
      .trimEnd();

    const [appendJson, encodedStateJson, slashEscapedStateJson, streamOutput, trailingOutput] =
      stdout.split(/\n---(?:\n|$)/);

    expect(result.stderr).toBe("");
    expect(trailingOutput).toBe("");
    expect(JSON.parse(appendJson)).toEqual({
      event: {
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: {
          curl: true,
        },
        offset: 2,
        streamPath: "<streamPath>",
        createdAt: "<ts>",
      },
    });
    expect(JSON.parse(encodedStateJson)).toMatchObject({
      projectSlug: defaultE2EProjectSlug,
      path: "<streamPath>",
      eventCount: 2,
      childPaths: [],
      metadata: {},
      processors: {
        "circuit-breaker": {
          paused: false,
          pauseReason: null,
          pausedAt: null,
          recentEventTimestamps: ["<ts>", "<ts>"],
        },
        "dynamic-worker": {
          workersBySlug: {},
        },
        "jsonata-transformer": {
          transformersBySlug: {},
        },
        scheduler: {},
      },
    });
    expect(JSON.parse(slashEscapedStateJson)).toMatchObject({
      projectSlug: defaultE2EProjectSlug,
      path: "<streamPath>",
      eventCount: 2,
      childPaths: [],
      metadata: {},
      processors: {
        "circuit-breaker": {
          paused: false,
          pauseReason: null,
          pausedAt: null,
          recentEventTimestamps: ["<ts>", "<ts>"],
        },
        "dynamic-worker": {
          workersBySlug: {},
        },
        "jsonata-transformer": {
          transformersBySlug: {},
        },
        scheduler: {},
      },
    });
    const streamMessages = streamOutput
      .split("\n\n")
      .filter((segment) => segment.length > 0)
      .map((segment) => segment.trimEnd());
    expect(streamMessages[0].startsWith(":")).toBe(true);
    expect(parseSseMessage(streamMessages[1])).toEqual({
      createdAt: "<ts>",
      offset: 1,
      payload: {
        path: "<streamPath>",
        projectSlug: defaultE2EProjectSlug,
      },
      streamPath: "<streamPath>",
      type: "https://events.iterate.com/events/stream/initialized",
    });
    expect(parseSseMessage(streamMessages[2])).toEqual({
      createdAt: "<ts>",
      offset: 2,
      payload: {
        curl: true,
      },
      streamPath: "<streamPath>",
      type: "https://events.iterate.com/events/example/value-recorded",
    });
  }, 15_000);

  test("curl append with type-only body (no payload) defaults payload to empty object", async () => {
    const baseURL = process.env.EVENTS_BASE_URL?.trim().replace(/\/+$/, "");
    if (!baseURL) {
      throw new Error(
        "EVENTS_BASE_URL is required. Example: EVENTS_BASE_URL=http://127.0.0.1:5174 pnpm test:e2e",
      );
    }

    const streamPath = StreamPath.parse(`/e2e-curl-nopayload/${randomUUID().slice(0, 8)}`);
    const streamCurlPath = streamPath.slice(1);

    const result = await x(
      "bash",
      [
        "-lc",
        `set -euo pipefail
curl -sS -X POST "$BASE_URL/api/streams/$STREAM_CURL_PATH" \
  -H 'content-type: application/json' \
  -H "x-iterate-project: $PROJECT_SLUG" \
  -d '{"type":"hello"}'`,
      ],
      {
        throwOnError: false,
        nodeOptions: {
          stdio: "pipe",
          env: {
            ...process.env,
            BASE_URL: baseURL,
            PROJECT_SLUG: defaultE2EProjectSlug,
            STREAM_CURL_PATH: streamCurlPath,
          },
        },
      },
    );

    expect(result.exitCode).toBe(0);

    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({
      event: {
        streamPath,
        type: "hello",
        payload: {},
      },
    });
  }, 15_000);
});

function parseSseMessage(segment: string) {
  const [eventLine, dataLine] = segment.split("\n");
  expect(eventLine).toBe("event: message");
  expect(dataLine.startsWith("data: ")).toBe(true);
  return JSON.parse(dataLine.slice("data: ".length));
}

/**
 * Same curls as below, runnable in a terminal after:
 *   export BASE_URL="http://127.0.0.1:5174"
 *   export STREAM_CURL_PATH="e2e-curl/xxxxxxxx"
 *   export STREAM_RPATH="e2e-curl%2Fxxxxxxxx"   # same path with slashes → %2F
 *
 *   curl -sS -X POST "$BASE_URL/api/streams/$STREAM_CURL_PATH" \
 *     -H 'content-type: application/json' \
 *     -d '{"type":"https://events.iterate.com/events/example/value-recorded","payload":{"curl":true}}'
 *   echo
 *   echo '---'
 *   curl -sS "$BASE_URL/api/__state/$STREAM_CURL_PATH"
 *   echo
 *   echo '---'
 *   curl -sS "$BASE_URL/api/__state/$STREAM_RPATH"
 *   echo
 *   echo '---'
 *   curl -sS -N "$BASE_URL/api/streams/$STREAM_CURL_PATH"
 *   echo
 *   echo '---'
 *   curl -sS "$BASE_URL/api/streams" >/dev/null
 *   curl -sS "$BASE_URL/api/__state/%2F" >/dev/null
 *
 * Test run: `EVENTS_BASE_URL` matches `BASE_URL` (no trailing slash).
 */
import { randomUUID } from "node:crypto";
import { StreamPath } from "@iterate-com/events-contract";
import { x } from "tinyexec";
import { describe, expect, test } from "vitest";

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
    const streamRpath = streamPath === "/" ? "%2F" : streamPath.slice(1).replaceAll("/", "%2F");

    const script = `
set -euo pipefail

curl -sS -X POST "$BASE_URL/api/streams/$STREAM_CURL_PATH" \\
  -H 'content-type: application/json' \\
  -d '{"type":"https://events.iterate.com/events/example/value-recorded","payload":{"curl":true}}'
echo
echo '---'
curl -sS "$BASE_URL/api/__state/$STREAM_CURL_PATH"
echo
echo '---'
curl -sS "$BASE_URL/api/__state/$STREAM_RPATH"
echo
echo '---'
curl -sS -N "$BASE_URL/api/streams/$STREAM_CURL_PATH"
echo
echo '---'
curl -sS "$BASE_URL/api/streams" >/dev/null
curl -sS "$BASE_URL/api/__state/%2F" >/dev/null
`;

    const result = await x("sh", ["-c", script], {
      throwOnError: false,
      nodeOptions: {
        stdio: "pipe",
        env: {
          ...process.env,
          BASE_URL: baseURL,
          STREAM_CURL_PATH: streamCurlPath,
          STREAM_RPATH: streamRpath,
        },
      },
    });

    expect(result.exitCode).toBe(0);

    expect({
      stdout: result.stdout
        .replaceAll("\r\n", "\n")
        .replaceAll(streamPath, "<streamPath>")
        .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, "<ts>"),
      stderr: result.stderr,
    }).toMatchInlineSnapshot(`
      {
        "stderr": "",
        "stdout": "{
        "event": {
          "streamPath": "<streamPath>",
          "type": "https://events.iterate.com/events/example/value-recorded",
          "payload": {
            "curl": true
          },
          "offset": 2,
          "createdAt": "<ts>"
        }
      }
      ---
      {
        "path": "<streamPath>",
        "eventCount": 2,
        "metadata": {},
        "processors": {
          "circuit-breaker": {
            "paused": false,
            "pauseReason": null,
            "pausedAt": null,
            "recentEventTimestamps": [
              "<ts>",
              "<ts>"
            ]
          },
          "jsonata-transformer": {
            "transformersBySlug": {}
          }
        }
      }
      ---
      {
        "path": "<streamPath>",
        "eventCount": 2,
        "metadata": {},
        "processors": {
          "circuit-breaker": {
            "paused": false,
            "pauseReason": null,
            "pausedAt": null,
            "recentEventTimestamps": [
              "<ts>",
              "<ts>"
            ]
          },
          "jsonata-transformer": {
            "transformersBySlug": {}
          }
        }
      }
      ---
      : 

      event: message
      data: {"streamPath":"<streamPath>","type":"https://events.iterate.com/events/stream/initialized","payload":{},"offset":1,"createdAt":"<ts>"}

      event: message
      data: {"streamPath":"<streamPath>","type":"https://events.iterate.com/events/example/value-recorded","payload":{"curl":true},"offset":2,"createdAt":"<ts>"}


      ---
      ",
      }
    `);
  }, 15_000);
});

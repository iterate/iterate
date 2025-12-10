/**
 * OpenAI Fixture Server
 *
 * A standalone Node HTTP server that handles recording and replaying OpenAI API responses.
 * This server runs separately from the Cloudflare Worker and uses node:fs to persist fixtures.
 *
 * Fixtures are organized by test name, with sequential request numbering:
 *   __fixtures__/openai-recordings/
 *     my-test-name/
 *       request-0.json
 *       request-1.json
 *
 * Endpoints:
 * - POST /start-test - Initialize a test session (resets request counter)
 * - POST /record - Store a request/response pair sequentially
 * - POST /replay - Look up a fixture by test name and request index, with diff on mismatch
 * - GET /health - Health check
 */
import * as assert from "node:assert";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as R from "remeda";
import * as YAML from "yaml";
import gitDiff from "git-diff";

export interface FixtureServerOptions {
  port: number;
  fixturesDir: string;
}

export interface StartTestRequest {
  testName: string;
}

export interface RecordRequest {
  testName: string;
  request: {
    url: string;
    method: string;
    body: unknown;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    /** For streaming responses, this is an array of SSE chunks */
    chunks: unknown[];
  };
}

export interface ReplayRequest {
  testName: string;
  requestIndex: number;
  actualRequest: {
    url: string;
    method: string;
    body: unknown;
  };
}

export interface ReplayResponse {
  found: boolean;
  response?: {
    status: number;
    headers: Record<string, string>;
    chunks: unknown[];
  };
  error?: string;
  diff?: string;
}

/**
 * Strip volatile fields from response chunks for storage.
 * Replace with placeholders to maintain structure for debugging.
 */
function sanitizeResponseChunks(chunks: unknown[]): unknown[] {
  return chunks.map((chunk) => {
    if (typeof chunk !== "object" || chunk === null) {
      return chunk;
    }

    const volatileFields = ["created_at", "created", "id", "system_fingerprint"];

    function sanitize(obj: unknown): unknown {
      if (typeof obj !== "object" || obj === null) {
        return obj;
      }

      if (Array.isArray(obj)) {
        return obj.map(sanitize);
      }

      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        if (volatileFields.includes(key)) {
          result[key] = `__STRIPPED_${key.toUpperCase()}__`;
        } else {
          result[key] = sanitize(value);
        }
      }
      return result;
    }

    return sanitize(chunk);
  });
}

/**
 * Get a diff string between expected and actual objects using assert.deepStrictEqual.
 * Returns null if objects are equal.
 */
function getRequestDiff(expected: unknown, actual: unknown): string | null {
  if (R.isDeepEqual(actual, expected)) {
    return null;
  }
  return gitDiff(YAML.stringify(actual), YAML.stringify(expected), { color: true });
  try {
    assert.equal(YAML.stringify(actual), YAML.stringify(expected));
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * Remove sensitive headers from response.
 */
function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  const sensitiveHeaders = [
    "authorization",
    "x-request-id",
    "openai-organization",
    "openai-processing-ms",
    "x-ratelimit-limit-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
    "cf-ray",
    "cf-cache-status",
    "set-cookie",
  ];

  for (const [key, value] of Object.entries(headers)) {
    if (!sensitiveHeaders.includes(key.toLowerCase())) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function stripVolatileFields<T>(obj: T): T {
  const yaml = YAML.stringify(
    JSON.parse(
      JSON.stringify(obj, (key, value) => {
        if (key === "headers" && value && typeof value === "object")
          return Object.fromEntries(Object.keys(value).map((key) => [key, "..."]));
        return value;
      }),
    ),
  );
  const stripped = yaml
    .replace(/_[a-z0-9]{26}\b/g, "_<typeid>") // any typeid-js generated string
    .replace(/\busr_\w+\b/g, "usr_...")
    .replace(/\btest_slack_user_\w+\b/g, "usr_...")
    .replace(/email: .*@/g, "email: ...@")
    .replace(/"ts": "\d+"/g, '"ts": "..."')
    .replace(/"createdAt": ".*?"/g, '"createdAt": "..."')
    .replace(/TEST_slack-\w+\b/g, "TEST_slack-...")
    .split("\n")
    .filter((line, i, arr) => line.trim() || arr[i + 1]?.trim()) // get rid of multiple empty lines, for some reason this is inconsistent
    .join("\n");

  return YAML.parse(stripped);
}

/**
 * Create and start the fixture server.
 */
export function createFixtureServer(options: FixtureServerOptions): {
  server: http.Server;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const { port, fixturesDir } = options;

  // Ensure fixtures directory exists
  if (!fs.existsSync(fixturesDir)) {
    fs.mkdirSync(fixturesDir, { recursive: true });
  }

  // Track request counters per test (for recording)
  const testRequestCounters = new Map<string, number>();

  function getTestDir(testName: string): string {
    return path.join(fixturesDir, testName);
  }

  function getFixturePath(testName: string, requestIndex: number): string {
    return path.join(getTestDir(testName), `request-${requestIndex}.yaml`);
  }

  const server = http.createServer(async (req, res) => {
    // CORS headers for cross-origin requests from miniflare
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    try {
      if (url.pathname === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (url.pathname === "/start-test" && req.method === "POST") {
        const body = await readRequestBody(req);
        const data: StartTestRequest = JSON.parse(body);

        // Reset request counter for this test
        testRequestCounters.set(data.testName, 0);

        // Create test directory if it doesn't exist
        const testDir = getTestDir(data.testName);
        if (!fs.existsSync(testDir)) {
          fs.mkdirSync(testDir, { recursive: true });
        }

        console.log(`[fixture-server] Started test session: ${data.testName}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      if (url.pathname === "/record" && req.method === "POST") {
        const body = await readRequestBody(req);
        const data: RecordRequest = JSON.parse(body);

        // Get and increment request counter
        const requestIndex = testRequestCounters.get(data.testName) ?? 0;
        testRequestCounters.set(data.testName, requestIndex + 1);

        const fixturePath = getFixturePath(data.testName, requestIndex);

        // Create test directory if needed
        const testDir = getTestDir(data.testName);
        if (!fs.existsSync(testDir)) {
          fs.mkdirSync(testDir, { recursive: true });
        }

        const fixture = {
          requestIndex,
          request: {
            url: data.request.url,
            method: data.request.method,
            body: data.request.body, // Store full request body
          },
          response: {
            status: data.response.status,
            headers: sanitizeHeaders(data.response.headers),
            chunks: sanitizeResponseChunks(data.response.chunks),
          },
          recordedAt: new Date().toISOString(),
        };

        fs.writeFileSync(fixturePath, YAML.stringify(fixture, null, 2));
        console.log(`[fixture-server] Recorded: ${data.testName}/request-${requestIndex}`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, requestIndex }));
        return;
      }

      if (url.pathname === "/replay" && req.method === "POST") {
        const body = await readRequestBody(req);
        const data: ReplayRequest = JSON.parse(body);

        const fixturePath = getFixturePath(data.testName, data.requestIndex);

        if (!fs.existsSync(fixturePath)) {
          const testDir = getTestDir(data.testName);
          const testDirExists = fs.existsSync(testDir);

          let errorMsg: string;
          if (!testDirExists) {
            errorMsg =
              `No fixtures recorded for test "${data.testName}".\n\n` +
              `To record fixtures, run tests with OPENAI_RECORD_MODE=record:\n` +
              `  OPENAI_RECORD_MODE=record pnpm e2e`;
          } else {
            const existingFixtures = fs
              .readdirSync(testDir)
              .filter((f) => f.endsWith(".json")).length;
            errorMsg =
              `Fixture not found: ${data.testName}/request-${data.requestIndex}\n` +
              `(Test has ${existingFixtures} recorded fixture(s))\n\n` +
              `To re-record fixtures, run tests with OPENAI_RECORD_MODE=record:\n` +
              `  OPENAI_RECORD_MODE=record pnpm e2e`;
          }

          console.log(`[fixture-server] ${errorMsg}`);
          const response: ReplayResponse = { found: false, error: errorMsg };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
          return;
        }

        const fixture = YAML.parse(fs.readFileSync(fixturePath, "utf-8"));

        // Compare request bodies (with volatile fields stripped)
        const expectedBody = stripVolatileFields(fixture.request.body);
        const actualBody = stripVolatileFields(data.actualRequest.body);
        const diff = getRequestDiff(expectedBody, actualBody);

        if (diff) {
          const errorMsg =
            `Request mismatch in test "${data.testName}" (request #${data.requestIndex})\n\n` +
            `${diff}\n\n` +
            `To re-record fixtures, run tests with OPENAI_RECORD_MODE=record:\n` +
            `  OPENAI_RECORD_MODE=record pnpm e2e`;

          console.log(
            `[fixture-server] Request mismatch: ${data.testName}/request-${data.requestIndex}`,
            errorMsg,
          );
          const response: ReplayResponse = { found: true, error: errorMsg, diff };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
          return;
        }

        console.log(`[fixture-server] Replaying: ${data.testName}/request-${data.requestIndex}`);
        const response: ReplayResponse = {
          found: true,
          response: fixture.response,
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      console.error("[fixture-server] Error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });

  return {
    server,
    start: () =>
      new Promise((resolve) => {
        server.listen(port, () => {
          console.log(`[fixture-server] Listening on port ${port}`);
          resolve();
        });
      }),
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.env.FIXTURE_SERVER_PORT ?? "9876", 10);
  const fixturesDir =
    process.env.FIXTURES_DIR ?? path.join(import.meta.dirname, "__fixtures__", "openai-recordings");

  const { start } = createFixtureServer({ port, fixturesDir });
  start();
}

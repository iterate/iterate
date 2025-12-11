import * as path from "node:path";
import * as fs from "node:fs";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { OpenAI } from "openai";
import { createRecordReplayFetch } from "../backend/agent/openai-record-replay-fetch.ts";
import { createFixtureServer } from "./openai-fixture-server.ts";

describe("OpenAI Fixture Server", () => {
  const testFixturesDir = path.join(import.meta.dirname, "__fixtures__", "openai-recordings-test");
  const port = 9877;
  let fixtureServer: ReturnType<typeof createFixtureServer>;
  const baseUrl = `http://localhost:${port}`;

  beforeAll(async () => {
    // Clean up test fixtures dir
    if (fs.existsSync(testFixturesDir)) {
      fs.rmSync(testFixturesDir, { recursive: true });
    }
    fs.mkdirSync(testFixturesDir, { recursive: true });

    fixtureServer = createFixtureServer({ port, fixturesDir: testFixturesDir });
    await fixtureServer.start();
  });

  afterAll(async () => {
    await fixtureServer.stop();
    // Clean up
    if (fs.existsSync(testFixturesDir)) {
      fs.rmSync(testFixturesDir, { recursive: true });
    }
  });

  test("health check returns ok", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data).toEqual({ status: "ok" });
  });

  test("start-test creates directory and resets counter", async () => {
    const testName = "my-test-case";

    const response = await fetch(`${baseUrl}/start-test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testName }),
    });
    expect(response.ok).toBe(true);

    // Directory should exist
    const testDir = path.join(testFixturesDir, testName);
    expect(fs.existsSync(testDir)).toBe(true);
  });

  test("record and replay sequential fixtures", async () => {
    const testName = "sequential-test";

    // Start test session
    await fetch(`${baseUrl}/start-test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testName }),
    });

    // Record first request
    const request1 = {
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      body: { model: "gpt-4", messages: [{ role: "user", content: "Hello" }] },
    };
    const response1 = {
      status: 200,
      headers: { "content-type": "application/json" },
      chunks: [{ id: "resp_1", choices: [{ message: { content: "Hi!" } }] }],
    };

    await fetch(`${baseUrl}/record`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testName, request: request1, response: response1 }),
    });

    // Record second request
    const request2 = {
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      body: { model: "gpt-4", messages: [{ role: "user", content: "How are you?" }] },
    };
    const response2 = {
      status: 200,
      headers: { "content-type": "application/json" },
      chunks: [{ id: "resp_2", choices: [{ message: { content: "Good!" } }] }],
    };

    await fetch(`${baseUrl}/record`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testName, request: request2, response: response2 }),
    });

    // Verify files were created (stored as YAML)
    expect(fs.existsSync(path.join(testFixturesDir, testName, "request-0.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(testFixturesDir, testName, "request-1.yaml"))).toBe(true);

    // Replay first request (should match)
    const replayResponse1 = await fetch(`${baseUrl}/replay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        testName,
        requestIndex: 0,
        actualRequest: request1,
      }),
    });
    const replayData1 = (await replayResponse1.json()) as {
      found: boolean;
      response?: { chunks: Array<{ id: string }> };
      error?: string;
    };
    expect(replayData1.found).toBe(true);
    expect(replayData1.error).toBeUndefined();
    // ID should be stripped in stored fixture
    expect(replayData1.response?.chunks[0].id).toBe("__STRIPPED_ID__");

    // Replay second request
    const replayResponse2 = await fetch(`${baseUrl}/replay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        testName,
        requestIndex: 1,
        actualRequest: request2,
      }),
    });
    const replayData2 = (await replayResponse2.json()) as { found: boolean };
    expect(replayData2.found).toBe(true);
  });

  test("replay returns error when fixture not found", async () => {
    const response = await fetch(`${baseUrl}/replay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        testName: "nonexistent-test",
        requestIndex: 0,
        actualRequest: { url: "test", method: "GET", body: null },
      }),
    });
    expect(response.ok).toBe(true);

    const data = (await response.json()) as { found: boolean; error: string };
    expect(data.found).toBe(false);
    expect(data.error).toContain("No fixtures recorded for test");
    expect(data.error).toContain("OPENAI_RECORD_MODE=record");
  });

  test("replay returns diff when request body does not match", async () => {
    const testName = "diff-test";

    // Start test and record a fixture
    await fetch(`${baseUrl}/start-test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testName }),
    });

    const originalRequest = {
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      body: { model: "gpt-4", messages: [{ role: "user", content: "Hello" }] },
    };

    await fetch(`${baseUrl}/record`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        testName,
        request: originalRequest,
        response: { status: 200, headers: {}, chunks: [{}] },
      }),
    });

    // Try to replay with different request body
    const differentRequest = {
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      body: { model: "gpt-4", messages: [{ role: "user", content: "Goodbye" }] },
    };

    const response = await fetch(`${baseUrl}/replay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        testName,
        requestIndex: 0,
        actualRequest: differentRequest,
      }),
    });

    const data = (await response.json()) as { found: boolean; error: string; diff: string };
    expect(data.found).toBe(true);
    expect(data.error).toContain("Request mismatch");
    expect(data.diff).toBeTruthy();
    // The diff should mention the different content
    expect(data.error).toContain("Hello");
  });

  test("volatile fields are stripped for comparison", async () => {
    const testName = "volatile-fields-test";

    // Start test and record a fixture
    await fetch(`${baseUrl}/start-test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testName }),
    });

    // The stripVolatileFields function strips specific patterns used in e2e tests:
    // - typeids (_[a-z0-9]{26})
    // - user IDs (usr_...)
    // - test_slack_user_* patterns
    // - emails
    // - "ts" fields (slack timestamps)
    // - "createdAt" fields
    // - TEST_slack-* patterns
    const originalRequest = {
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      body: {
        model: "gpt-4",
        messages: [{ role: "user", content: "Hello" }],
        userId: "usr_abc123def456", // Will be stripped to usr_...
        email: "test@example.com", // Will be stripped
        ts: "1234567890", // Will be stripped (slack timestamp)
        createdAt: "2024-01-01T00:00:00Z", // Will be stripped
      },
    };

    await fetch(`${baseUrl}/record`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        testName,
        request: originalRequest,
        response: { status: 200, headers: {}, chunks: [{}] },
      }),
    });

    // Replay with different volatile fields but same semantic content
    const requestWithDifferentVolatileFields = {
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      body: {
        model: "gpt-4",
        messages: [{ role: "user", content: "Hello" }],
        userId: "usr_xyz789ghi012", // Different user ID
        email: "other@example.com", // Different email
        ts: "9999999999", // Different slack timestamp
        createdAt: "2025-12-31T23:59:59Z", // Different createdAt
      },
    };

    const response = await fetch(`${baseUrl}/replay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        testName,
        requestIndex: 0,
        actualRequest: requestWithDifferentVolatileFields,
      }),
    });

    const data = (await response.json()) as { found: boolean; error?: string };
    expect(data.found).toBe(true);
    expect(data.error).toBeUndefined(); // Should match because volatile fields are stripped
  });

  test("SSE streaming replay works with OpenAI SDK", async () => {
    const testName = "sse-streaming-test";

    // Start test session
    await fetch(`${baseUrl}/start-test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testName }),
    });

    // Record a streaming SSE response (simulating OpenAI Responses API)
    const request = {
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      body: { model: "gpt-4", input: "Hello", stream: true },
    };
    const sseChunks = [
      {
        type: "response.created",
        sequence_number: 0,
        response: { id: "resp_1", status: "in_progress" },
      },
      {
        type: "response.output_item.added",
        sequence_number: 1,
        item: { type: "message", content: [] },
      },
      {
        type: "response.output_item.done",
        sequence_number: 2,
        item: { type: "message", content: [{ type: "text", text: "Hello!" }] },
      },
      { type: "response.completed", sequence_number: 3 },
    ];

    await fetch(`${baseUrl}/record`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        testName,
        request,
        response: {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
          chunks: sseChunks,
        },
      }),
    });

    // Create a record/replay fetch wrapper in replay mode
    const replayFetch = createRecordReplayFetch({
      mode: "replay",
      fixtureServerUrl: baseUrl,
      testName,
    });

    // Make a request through the replay fetch
    const response = await replayFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4", input: "Hello", stream: true }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    // Read the response body as text
    const responseText = await response.text();

    // Verify SSE format - each chunk should be `data: {...}\n\n`
    const expectedChunks = sseChunks.map(
      (chunk) => `data: ${JSON.stringify({ ...chunk, id: "__STRIPPED_ID__" })}`,
    );
    expectedChunks.push("data: [DONE]");

    // The chunks should be separated by double newlines
    expect(responseText).toContain("data: ");
    expect(responseText).toContain("data: [DONE]");

    // Parse the SSE response to verify we can extract the chunks
    const receivedChunks: unknown[] = [];
    for (const line of responseText.split("\n")) {
      if (line.startsWith("data: ") && !line.includes("[DONE]")) {
        receivedChunks.push(JSON.parse(line.slice(6)));
      }
    }

    // Should have all 4 chunks
    expect(receivedChunks).toHaveLength(4);
    expect(receivedChunks[0]).toMatchObject({ type: "response.created" });
    expect(receivedChunks[3]).toMatchObject({ type: "response.completed" });
  });

  test("SSE streaming works with actual OpenAI SDK", async () => {
    const testName = "openai-sdk-sse-test";

    // Start test session
    await fetch(`${baseUrl}/start-test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testName }),
    });

    // Record a streaming SSE response that looks like what OpenAI Responses API returns
    const request = {
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      body: { model: "gpt-4o-mini", input: "Say hello", stream: true },
    };

    // Realistic OpenAI Responses API streaming chunks
    const sseChunks = [
      {
        type: "response.created",
        sequence_number: 0,
        response: {
          id: "resp_test123",
          object: "response",
          created_at: 1234567890,
          status: "in_progress",
          output: [],
        },
      },
      { type: "response.in_progress", sequence_number: 1 },
      {
        type: "response.output_item.added",
        sequence_number: 2,
        output_index: 0,
        item: { type: "message", id: "msg_test", role: "assistant", content: [] },
      },
      {
        type: "response.content_part.added",
        sequence_number: 3,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "" },
      },
      {
        type: "response.output_text.delta",
        sequence_number: 4,
        output_index: 0,
        content_index: 0,
        delta: "Hello",
      },
      {
        type: "response.output_text.delta",
        sequence_number: 5,
        output_index: 0,
        content_index: 0,
        delta: "!",
      },
      {
        type: "response.output_text.done",
        sequence_number: 6,
        output_index: 0,
        content_index: 0,
        text: "Hello!",
      },
      {
        type: "response.content_part.done",
        sequence_number: 7,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "Hello!" },
      },
      {
        type: "response.output_item.done",
        sequence_number: 8,
        output_index: 0,
        item: {
          type: "message",
          id: "msg_test",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello!" }],
        },
      },
      {
        type: "response.completed",
        sequence_number: 9,
        response: {
          id: "resp_test123",
          object: "response",
          created_at: 1234567890,
          status: "completed",
          output: [
            {
              type: "message",
              id: "msg_test",
              role: "assistant",
              content: [{ type: "output_text", text: "Hello mate!" }],
            },
          ],
        },
      },
    ];

    await fetch(`${baseUrl}/record`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        testName,
        request,
        response: {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
          chunks: sseChunks,
        },
      }),
    });

    // Create OpenAI client with record/replay fetch
    const replayFetch = createRecordReplayFetch({
      mode: "replay",
      fixtureServerUrl: baseUrl,
      testName,
    });

    const openai = new OpenAI({
      apiKey: "test-api-key-not-used-in-replay",
      fetch: replayFetch,
    });

    // Use the OpenAI SDK to make a streaming request
    const stream = await openai.responses.create({
      model: "gpt-4o-mini",
      input: "Say hello",
      stream: true,
    });

    // Consume the stream and collect events
    const events: Array<{ type: string }> = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Verify we got all the events
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((e) => e.type)).toContain("response.created");
    expect(events.map((e) => e.type)).toContain("response.completed");
    expect(JSON.stringify(events, null, 2)).toContain("Hello mate!");
  });
});

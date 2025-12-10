import * as path from "node:path";
import * as fs from "node:fs";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
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

    // Verify files were created
    expect(fs.existsSync(path.join(testFixturesDir, testName, "request-0.json"))).toBe(true);
    expect(fs.existsSync(path.join(testFixturesDir, testName, "request-1.json"))).toBe(true);

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

    const originalRequest = {
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      body: {
        model: "gpt-4",
        messages: [{ id: "msg_123", role: "user", content: "Hello" }],
        timestamp: 1234567890,
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
        messages: [{ id: "msg_456", role: "user", content: "Hello" }], // Different ID
        timestamp: 9999999999, // Different timestamp
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
});

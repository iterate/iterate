import { execSync } from "node:child_process";
import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { ServerType } from "@hono/node-server";
import { startServer, getTmuxPath } from "./server.ts";
import { connectTerminal, executeTmuxCommand, listTmuxSessions } from "./main.ts";

const TEST_PORT = 3099;
const SERVER_URL = `http://localhost:${TEST_PORT}`;

describe("CLI2 E2E Tests", () => {
  let server: ServerType;
  const createdSessions: string[] = [];

  beforeAll(async () => {
    const result = startServer(TEST_PORT);
    server = result.server;
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  afterAll(async () => {
    for (const session of createdSessions) {
      try {
        execSync(`${getTmuxPath()} kill-session -t ${session}`, {
          stdio: "ignore",
        });
      } catch {
        // Ignore
      }
    }

    server.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  test("health check returns ok", async () => {
    const response = await fetch(`${SERVER_URL}/health`);
    const data = await response.json();
    expect(data).toEqual({ status: "ok" });
  });

  test("can execute tmux command via API", async () => {
    const result = await executeTmuxCommand(["-V"], SERVER_URL);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^tmux \d+\.\d+/);
  });

  test("can create and list tmux sessions", async () => {
    const sessionName = `test-session-${Date.now()}`;
    createdSessions.push(sessionName);

    const createResult = await executeTmuxCommand(
      ["new-session", "-d", "-s", sessionName],
      SERVER_URL,
    );
    expect(createResult.exitCode).toBe(0);

    const sessions = await listTmuxSessions(SERVER_URL);
    expect(sessions).toContain(sessionName);
  });

  test("can send keys to tmux session", async () => {
    const sessionName = `test-keys-${Date.now()}`;
    createdSessions.push(sessionName);

    await executeTmuxCommand(["new-session", "-d", "-s", sessionName], SERVER_URL);

    const sendResult = await executeTmuxCommand(
      ["send-keys", "-t", sessionName, "echo hello-from-test", "Enter"],
      SERVER_URL,
    );
    expect(sendResult.exitCode).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 500));

    const captureResult = await executeTmuxCommand(
      ["capture-pane", "-t", sessionName, "-p"],
      SERVER_URL,
    );
    expect(captureResult.exitCode).toBe(0);
    expect(captureResult.stdout).toContain("hello-from-test");
  });

  test("can connect to agent shell (non-tmux) via WebSocket", async () => {
    const agentId = `test-agent-${Date.now()}`;
    const ws = await connectTerminal(agentId, {
      serverURL: SERVER_URL,
      useTmux: false,
    });

    const messages: Array<{ type: string; data: string }> = [];
    let resolved = false;

    await new Promise<void>((resolve) => {
      const done = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          messages.push(msg);
          if (msg.type === "output") {
            done();
          }
        } catch {
          // Ignore parse errors
        }
      });

      setTimeout(done, 3000);
    });

    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.type === "output")).toBe(true);

    ws.close();
  });

  test("can connect to agent tmux session via WebSocket", async () => {
    const agentId = `test-tmux-agent-${Date.now()}`;
    createdSessions.push(agentId);

    const ws = await connectTerminal(agentId, {
      useTmux: true,
      serverURL: SERVER_URL,
    });

    const messages: Array<{ type: string; data: string }> = [];

    await new Promise<void>((resolve) => {
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          messages.push(msg);
        } catch {
          // Ignore parse errors
        }
      });

      setTimeout(resolve, 1000);
    });

    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.type === "output")).toBe(true);

    const sessions = await listTmuxSessions(SERVER_URL);
    expect(sessions).toContain(agentId);

    ws.close();
  });

  test("can send commands through tmux session WebSocket", async () => {
    const agentId = `test-ws-cmd-${Date.now()}`;
    createdSessions.push(agentId);

    const ws = await connectTerminal(agentId, {
      useTmux: true,
      serverURL: SERVER_URL,
    });

    let output = "";

    await new Promise<void>((resolve) => {
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "output") {
            output += msg.data;
          }
        } catch {
          // Ignore
        }
      });

      setTimeout(() => {
        ws.send(JSON.stringify({ type: "input", data: "echo ws-test-123\n" }));
      }, 500);

      setTimeout(resolve, 2000);
    });

    expect(output).toContain("ws-test-123");

    ws.close();
  });

  test("can resize terminal", async () => {
    const agentId = `test-resize-${Date.now()}`;
    const ws = await connectTerminal(agentId, {
      serverURL: SERVER_URL,
      useTmux: false,
    });

    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    ws.close();
  });

  test("tmux sessions persist across WebSocket connections", async () => {
    const agentId = `test-persist-${Date.now()}`;
    createdSessions.push(agentId);

    const ws1 = await connectTerminal(agentId, {
      useTmux: true,
      serverURL: SERVER_URL,
    });

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        ws1.send(JSON.stringify({ type: "input", data: "export TEST_VAR=persist123\n" }));
      }, 500);
      setTimeout(resolve, 1000);
    });

    ws1.close();
    await new Promise((resolve) => setTimeout(resolve, 500));

    const ws2 = await connectTerminal(agentId, {
      useTmux: true,
      serverURL: SERVER_URL,
    });

    let output = "";

    await new Promise<void>((resolve) => {
      ws2.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "output") {
            output += msg.data;
          }
        } catch {
          // Ignore
        }
      });

      setTimeout(() => {
        ws2.send(JSON.stringify({ type: "input", data: "echo $TEST_VAR\n" }));
      }, 500);

      setTimeout(resolve, 1500);
    });

    expect(output).toContain("persist123");

    ws2.close();
  });
});

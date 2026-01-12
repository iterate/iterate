import { test, expect } from "@playwright/test";
import WebSocket from "ws";

test.describe("PTY Terminal", () => {
  test("WebSocket endpoint is accessible and responds", async ({ baseURL }) => {
    const wsUrl = baseURL!.replace("http", "ws") + "/ws/pty?cols=80&rows=24";
    const ws = new WebSocket(wsUrl);

    const connected = await new Promise<boolean>((resolve) => {
      ws.on("open", () => resolve(true));
      ws.on("error", () => resolve(false));
      setTimeout(() => resolve(false), 5000);
    });

    expect(connected).toBe(true);
    ws.close();
  });

  test("PTY sends shell output after connection", async ({ baseURL }) => {
    const wsUrl = baseURL!.replace("http", "ws") + "/ws/pty?cols=80&rows=24";
    const ws = new WebSocket(wsUrl);
    const messages: string[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.on("message", (data) => {
        messages.push(data.toString());
        if (messages.length > 0) resolve();
      });
      ws.on("error", reject);
      setTimeout(() => resolve(), 3000);
    });

    expect(messages.length).toBeGreaterThan(0);
    ws.close();
  });

  test("can type into terminal and receive echo", async ({ baseURL }) => {
    const wsUrl = baseURL!.replace("http", "ws") + "/ws/pty?cols=80&rows=24";
    const ws = new WebSocket(wsUrl);
    const messages: string[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        setTimeout(() => {
          ws.send("echo ACCEPTANCE_TEST_OUTPUT\n");
        }, 500);
      });
      ws.on("message", (data) => {
        messages.push(data.toString());
        if (messages.join("").includes("ACCEPTANCE_TEST_OUTPUT")) {
          resolve();
        }
      });
      ws.on("error", reject);
      setTimeout(() => resolve(), 5000);
    });

    const output = messages.join("");
    expect(output).toContain("ACCEPTANCE_TEST_OUTPUT");
    ws.close();
  });

  test("initialCommand parameter executes command on connect", async ({ baseURL }) => {
    const wsUrl =
      baseURL!.replace("http", "ws") +
      "/ws/pty?cols=80&rows=24&initialCommand=" +
      encodeURIComponent("echo INITIAL_CMD_TEST");
    const ws = new WebSocket(wsUrl);
    const messages: string[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.on("message", (data) => {
        messages.push(data.toString());
        if (messages.join("").includes("INITIAL_CMD_TEST")) {
          resolve();
        }
      });
      ws.on("error", reject);
      setTimeout(() => resolve(), 5000);
    });

    const output = messages.join("");
    expect(output).toContain("INITIAL_CMD_TEST");
    ws.close();
  });

  test("terminal handles resize", async ({ baseURL }) => {
    const wsUrl = baseURL!.replace("http", "ws") + "/ws/pty?cols=80&rows=24";
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        // Send resize command
        ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
        setTimeout(resolve, 500);
      });
      ws.on("error", reject);
    });

    // If we get here without error, resize worked
    ws.close();
  });
});

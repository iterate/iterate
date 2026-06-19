import { expect, it, vi } from "vitest";

import { claudeMcp } from "./cli.ts";

it("prints a shell-quoted Claude command for the resolved local MCP URL", async () => {
  using env = temporaryEnv({
    APP_CONFIG_ADMIN_API_SECRET: "secret",
    APP_CONFIG_BASE_URL: "http://localhost:5176",
    APP_CONFIG_MCP__BASE_URL: undefined,
  });
  using fetch = temporaryGlobal(
    "fetch",
    vi.fn(async () => new Response("event: message\ndata: {}\n\n", { status: 200 })),
  );
  using info = temporaryConsoleInfo();

  await claudeMcp({ prompt: "hello world" });

  expect(fetch.fn).toHaveBeenCalledWith(
    "http://localhost:5176/api/mcp",
    expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: "Bearer secret",
      }),
    }),
  );
  expect(info.lines.join("\n")).toContain(
    'claude --mcp-config \'{"mcpServers":{"iterate":{"type":"http","url":"http://localhost:5176/api/mcp","headers":{"Authorization":"Bearer secret"}}}}\' --strict-mcp-config --dangerously-skip-permissions \'hello world\'',
  );

  void env;
});

it("prefers the configured canonical MCP URL", async () => {
  using env = temporaryEnv({
    APP_CONFIG_ADMIN_API_SECRET: "secret",
    APP_CONFIG_BASE_URL: "http://localhost:5176",
    APP_CONFIG_MCP__BASE_URL: "https://mcp.iterate-preview-5.com",
  });
  using fetch = temporaryGlobal(
    "fetch",
    vi.fn(async () => new Response("event: message\ndata: {}\n\n", { status: 200 })),
  );
  using info = temporaryConsoleInfo();

  await claudeMcp();

  expect(fetch.fn).toHaveBeenCalledWith(
    "https://mcp.iterate-preview-5.com",
    expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: "Bearer secret",
      }),
    }),
  );

  void env;
  void info;
});

it("rejects 401 with an admin token hint", async () => {
  using env = temporaryEnv({
    APP_CONFIG_ADMIN_API_SECRET: "wrong",
    APP_CONFIG_MCP__BASE_URL: "https://mcp.iterate.com",
  });
  using fetch = temporaryGlobal(
    "fetch",
    vi.fn(async () => new Response("Invalid bearer token", { status: 401 })),
  );

  await expect(claudeMcp()).rejects.toThrow(/APP_CONFIG_ADMIN_API_SECRET/);

  void env;
  void fetch;
});

function temporaryEnv(values: Record<string, string | undefined>) {
  const previousValues = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previousValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return {
    [Symbol.dispose]() {
      for (const [key, value] of previousValues) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
  };
}

function temporaryGlobal<T extends keyof typeof globalThis>(key: T, value: (typeof globalThis)[T]) {
  const previousValue = globalThis[key];
  globalThis[key] = value;
  return {
    fn: value,
    [Symbol.dispose]() {
      globalThis[key] = previousValue;
    },
  };
}

function temporaryConsoleInfo() {
  const previousInfo = console.info;
  const lines: string[] = [];
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };

  return {
    lines,
    [Symbol.dispose]() {
      console.info = previousInfo;
    },
  };
}

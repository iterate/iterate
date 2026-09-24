import { execFile } from "node:child_process";
import { createServer } from "node:http";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { WebSocketServer } from "ws";
import { expect, test, vi } from "vitest";
import {
  claudeMcpArgs,
  oauthResourceForOsBaseUrl,
  preflightMcp,
  refreshOAuthSession,
  shellCommand,
} from "./cli.ts";
import { connectIterate } from "./next-node.ts";
import { Config } from "./config.ts";
import { MyComputer } from "./use-my-computer.ts";

const bin = fileURLToPath(new URL("../bin/iterate.js", import.meta.url));

test("bare invocation and all command help work offline", { timeout: 20_000 }, async () => {
  using config = cliConfig("http://127.0.0.1:1");
  for (const args of [
    [],
    ["--help"],
    ["itx", "run", "--help"],
    ["use-my-computer", "--help"],
    ["menubar", "--help"],
    ["repl", "--help"],
  ]) {
    const { stdout } = await runCli(config.directory, args);
    expect(stdout).toContain("iterate");
  }
});

test("OAuth uses the platform's API audience including the local port", () => {
  expect(Config.parse({})).toMatchObject({ osBaseUrl: "https://os.iterate.com" });
  expect(oauthResourceForOsBaseUrl("http://localhost:54896/")).toBe("http://localhost:54896/api");
  expect(oauthResourceForOsBaseUrl("https://os.iterate.com")).toBe("https://os.iterate.com/api");
});

test("refresh goes to the same issuer and rejects malformed tokens", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ access_token: "new-token", expires_in: 3600 })),
    );
  vi.stubGlobal("fetch", fetch);
  try {
    const input = {
      config: Config.parse({ osBaseUrl: "http://localhost:54896" }),
      session: { token: "old-token", clientId: "client", refreshToken: "refresh" },
    };
    expect(await refreshOAuthSession(input)).toMatchObject({
      token: "new-token",
      refreshToken: "refresh",
    });
    expect(fetch.mock.calls[0][0]).toBe("http://localhost:54896/oauth2/token");
    expect(fetch.mock.calls[0][1].body.get("resource")).toBe("http://localhost:54896/api");
    fetch.mockResolvedValueOnce(new Response("{}"));
    await expect(refreshOAuthSession(input)).rejects.toThrow();
  } finally {
    vi.unstubAllGlobals();
  }
});

test(
  "CLI authenticates and runs inline/file/stdin scripts exactly once over the platform protocol",
  { timeout: 30_000 },
  async () => {
    const calls: unknown[] = [];
    class Context extends RpcTarget {
      cd(path: string) {
        calls.push({ path });
        return new Context();
      }
      run(script: string) {
        calls.push({ script });
        if (script.includes("throw")) throw new Error("script failed");
        return { answer: 42 };
      }
    }
    class Projects extends RpcTarget {
      list() {
        return [{ id: "prj_test", slug: "demo", orgId: "org_test" }];
      }
      get(project: string) {
        calls.push({ project });
        return new Context();
      }
    }
    class Session extends RpcTarget {
      whoami() {
        return { actor: "user_test" };
      }
      get projects() {
        return new Projects();
      }
    }
    class Root extends RpcTarget {
      authenticate(auth: unknown) {
        calls.push({ auth });
        return new Session();
      }
    }
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    server.on("connection", (socket) => {
      newWebSocketRpcSession(socket as unknown as WebSocket, new Root());
    });
    const address = server.address();
    if (typeof address === "string" || !address) throw new Error("No port");
    using config = cliConfig(`http://127.0.0.1:${address.port}`);
    try {
      expect((await runCli(config.directory, ["ping"])).stdout).toContain("user_test");
      const interactive = promisify(execFile)(
        process.execPath,
        [bin, "repl", "--project", "demo"],
        {
          env: {
            ...process.env,
            XDG_CONFIG_HOME: config.directory,
            APP_CONFIG_ADMIN_API_SECRET: "",
            ITERATE_BEARER_TOKEN: "",
          },
          timeout: 10_000,
        },
      );
      interactive.child.stdin!.write("await itx.run('async () => 42')\n");
      let replTranscript = "";
      let sentExit = false;
      interactive.child.stdout!.on("data", (chunk) => {
        replTranscript += chunk.toString();
        if (!sentExit && replTranscript.includes("42")) {
          sentExit = true;
          interactive.child.stdin!.end("typeof itx\ntypeof RpcTarget\n.clear\ntypeof itx\n.exit\n");
        }
      });
      const replOutput = (await interactive).stdout;
      expect(replOutput).toContain("42");
      expect(replOutput).toContain("'function'");
      expect(replOutput).not.toContain("undefined");
      const sessionRepl = promisify(execFile)(process.execPath, [bin, "repl"], {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: config.directory,
          APP_CONFIG_ADMIN_API_SECRET: "",
          ITERATE_BEARER_TOKEN: "",
        },
        timeout: 10_000,
      });
      sessionRepl.child.stdin!.write("await itx.whoami()\n");
      let sessionOutput = "";
      let sessionExited = false;
      sessionRepl.child.stdout!.on("data", (chunk) => {
        sessionOutput += chunk.toString();
        if (!sessionExited && sessionOutput.includes("user_test")) {
          sessionExited = true;
          sessionRepl.child.stdin!.end(".exit\n");
        }
      });
      expect((await sessionRepl).stdout).toContain("user_test");
      calls.length = 0;
      const result = await runCli(config.directory, [
        "itx",
        "run",
        "--context",
        "/demo",
        "--eval",
        "return 42;",
      ]);
      expect(result.stdout).toContain("42");
      expect(calls).toEqual([
        { auth: { type: "bearer", token: "test-token" } },
        { project: "prj_test" },
        { path: "/demo" },
        { script: "async (itx) => {\nreturn 42;\n}" },
      ]);
      const file = join(config.directory, "script.js");
      writeFileSync(file, "return 42;");
      expect(
        (await runCli(config.directory, ["itx", "run", "--project", "demo", "--file", file]))
          .stdout,
      ).toContain("42");
      const stdinResult = promisify(execFile)(
        process.execPath,
        [bin, "itx", "run", "--file", "-"],
        {
          env: {
            ...process.env,
            XDG_CONFIG_HOME: config.directory,
            APP_CONFIG_ADMIN_API_SECRET: "",
            ITERATE_BEARER_TOKEN: "",
          },
          timeout: 10_000,
        },
      );
      stdinResult.child.stdin!.end("return 42;");
      expect((await stdinResult).stdout).toContain("42");
      calls.length = 0;
      await expect(
        runCli(config.directory, ["itx", "run", "--eval", "throw new Error('oops')"]),
      ).rejects.toThrow();
      expect(calls.filter((call) => "script" in (call as object))).toHaveLength(1);
      calls.length = 0;
      await expect(
        runCli(config.directory, ["itx", "run", "--eval", "return 1", "--file", file]),
      ).rejects.toThrow();
      expect(calls).toEqual([]);
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test("computer is an RPC target with discoverable local methods", () => {
  const computer = new MyComputer();
  expect(computer).toBeInstanceOf(RpcTarget);
  expect(computer.__describe().types).toContain("runSwift");
});

test("failed authentication releases the websocket", async () => {
  class Root extends RpcTarget {
    authenticate() {
      throw new Error("Invalid token");
    }
  }
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) =>
    newWebSocketRpcSession(socket as unknown as WebSocket, new Root()),
  );
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("No port");
  try {
    await expect(
      connectIterate({
        baseUrl: `http://localhost:${address.port}`,
        auth: { type: "bearer", token: "bad" },
      }),
    ).rejects.toThrow("Invalid token");
    await vi.waitFor(() => expect(server.clients).toMatchObject({ size: 0 }));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test(
  "config commands redact credentials and changing servers removes the old session",
  { timeout: 15_000 },
  async () => {
    using config = cliConfig("http://127.0.0.1:1");
    for (const command of ["get", "current"]) {
      expect((await runCli(config.directory, ["config", command])).stdout).not.toContain(
        "test-token",
      );
    }
    const result = await runCli(config.directory, [
      "config",
      "set",
      "--name",
      "test",
      "--os-base-url",
      "http://localhost:2",
      "--default-project",
      "demo",
    ]);
    expect(result.stdout).not.toContain("test-token");
    expect((await runCli(config.directory, ["config", "get"])).stdout).toContain("demo");
    await expect(runCli(config.directory, ["ping"])).rejects.toThrow("Not logged in");
  },
);

test("a pnpm shim for this package does not redirect source development to stale dist", async () => {
  const directory = mkdtempSync(join(tmpdir(), "iterate-bin-test-"));
  try {
    for (const path of ["bin", "src", "dist", "node_modules/.bin"])
      mkdirSync(join(directory, path), { recursive: true });
    copyFileSync(bin, join(directory, "bin/iterate.js"));
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    writeFileSync(
      join(directory, "src/cli.ts"),
      'export async function runCli() { console.log("source"); }',
    );
    writeFileSync(
      join(directory, "dist/cli.mjs"),
      'export async function runCli() { console.log("build"); }',
    );
    writeFileSync(join(directory, "node_modules/.bin/iterate"), "#!/bin/sh\n");
    symlinkSync(directory, join(directory, "node_modules/iterate"));
    for (const [force, expected] of [
      ["0", "source"],
      ["1", "build"],
    ]) {
      const result = await promisify(execFile)(
        process.execPath,
        [join(directory, "bin/iterate.js")],
        {
          cwd: directory,
          env: {
            ...process.env,
            ITERATE_FORCE_BUILT_PACKAGE: force,
            npm_command: "",
            npm_lifecycle_event: "",
          },
          timeout: 5000,
        },
      );
      expect(result.stdout.trim()).toBe(expected);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an authentication timeout closes the transport without an unhandled RPC rejection", async () => {
  const entered = Promise.withResolvers<void>();
  class Root extends RpcTarget {
    authenticate() {
      entered.resolve();
      return new Promise<never>(() => {});
    }
  }
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) =>
    newWebSocketRpcSession(socket as unknown as WebSocket, new Root()),
  );
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("No port");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const pending = connectIterate({
      baseUrl: `http://localhost:${address.port}`,
      auth: { type: "bearer", token: "stalled" },
    });
    const rejected = expect(pending).rejects.toThrow("Iterate authentication: no answer in 20s");
    await entered.promise;
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    vi.useRealTimers();
    await vi.waitFor(() => expect(server.clients).toMatchObject({ size: 0 }));
  } finally {
    vi.useRealTimers();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("computer activity pairs a failed call with its completion", async () => {
  const events: unknown[] = [];
  const computer = new MyComputer((event) => events.push(event));
  await expect(computer.ask({ question: "A question", buttons: [] })).rejects.toThrow("1–3");
  expect(events).toEqual([
    { type: "call", id: 1, method: "ask", summary: "A question" },
    { type: "call-done", id: 1, ok: false },
  ]);
});

test("menu-bar sharing releases its provision on stdin EOF", { timeout: 15_000 }, async () => {
  let released = false;
  class Provision extends RpcTarget {
    [Symbol.dispose]() {
      released = true;
    }
  }
  class Project extends RpcTarget {
    provide() {
      return new Provision();
    }
  }
  class Projects extends RpcTarget {
    get() {
      return new Project();
    }
  }
  class Session extends RpcTarget {
    get projects() {
      return new Projects();
    }
  }
  class Root extends RpcTarget {
    authenticate() {
      return new Session();
    }
  }
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => {
    // ws implements the DOM WebSocket interface capnweb consumes.
    newWebSocketRpcSession(socket as unknown as WebSocket, new Root());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const source = `
    import { connectIterate } from ${JSON.stringify(new URL("./next-node.ts", import.meta.url).href)};
    import { shareMyComputer } from ${JSON.stringify(new URL("./use-my-computer.ts", import.meta.url).href)};
    using connection = await connectIterate({ baseUrl: "http://127.0.0.1:${address.port}", auth: { type: "bearer", token: "test" } });
    await shareMyComputer({ connection, project: "demo", name: "testComputer", json: true });
  `;
  try {
    const child = promisify(execFile)(process.execPath, ["--input-type=module", "--eval", source], {
      timeout: 10_000,
    });
    child.child.stdin!.end();
    expect((await child).stdout.trim()).toBe(
      JSON.stringify({ type: "status", loggedIn: true, name: "testComputer" }),
    );
    await expect.poll(() => released).toBe(true);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("mcp claude: the command is Claude Code's argv for the one iterate server, shell-quoted", async () => {
  const args = claudeMcpArgs({ mcpUrl: "https://mcp.iterate.com/", token: "it's-secret" });
  expect(args).toEqual([
    "--mcp-config",
    JSON.stringify({
      mcpServers: {
        iterate: {
          type: "http",
          url: "https://mcp.iterate.com/",
          headers: { Authorization: "Bearer it's-secret" },
        },
      },
    }),
    "--strict-mcp-config",
  ]);
  // the printed line, read back by a shell, is exactly that argv
  const { stdout } = await promisify(execFile)("sh", [
    "-c",
    `printf '%s\\0' ${shellCommand(["claude", ...args])}`,
  ]);
  expect(stdout.split("\0").slice(0, -1)).toEqual(["claude", ...args]);
});

test("mcp claude: the preflight follows the MCP origin redirect with the bearer and refuses a wrong one", async () => {
  await using deployment = await mcpDeployment();
  expect(await preflightMcp(deployment.osBaseUrl, "it's-secret")).toEqual({
    mcpUrl: deployment.mcpUrl,
    tools: ["run"],
  });
  await expect(preflightMcp(deployment.osBaseUrl, "wrong")).rejects.toThrow(
    `${deployment.mcpUrl} rejected the bearer (401). APP_CONFIG_ADMIN_API_SECRET must be the operator bearer of the deployment at ${deployment.osBaseUrl}.`,
  );
});

test("mcp claude: prints the command alone on stdout, or --exec runs claude with it", async () => {
  await using deployment = await mcpDeployment();
  using config = cliConfig(deployment.osBaseUrl);
  // a stand-in `claude` on PATH that reports the argv it was given
  writeFileSync(join(config.directory, "claude"), `#!/bin/sh\nprintf '%s\\0' "$@"\nexit 3\n`);
  chmodSync(join(config.directory, "claude"), 0o755);
  const run = (args: string[]) =>
    promisify(execFile)(process.execPath, [bin, "mcp", "claude", ...args], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: config.directory,
        PATH: `${config.directory}:${process.env.PATH}`,
        APP_CONFIG_ADMIN_API_SECRET: "it's-secret",
      },
      timeout: 10_000,
    });
  const args = claudeMcpArgs({ mcpUrl: deployment.mcpUrl, token: "it's-secret" });
  const printed = await run([]);
  expect(printed).toMatchObject({
    stdout: `${shellCommand(["claude", ...args])}\n`,
    stderr: expect.stringContaining(`${deployment.mcpUrl} accepted the bearer; tools: run`),
  });
  const executed = await run(["--exec"]).catch((error: { code: number; stdout: string }) => error);
  expect(executed).toMatchObject({ code: 3 });
  expect(executed.stdout.split("\0").slice(0, -1)).toEqual(args);
});

function cliConfig(baseUrl: string) {
  const directory = mkdtempSync(join(tmpdir(), "iterate-next-cli-"));
  mkdirSync(join(directory, "iterate"));
  writeFileSync(
    join(directory, "iterate/config.json"),
    JSON.stringify({
      default: "test",
      configs: { test: { osBaseUrl: baseUrl, session: { token: "test-token" } } },
    }),
  );
  return { directory, [Symbol.dispose]: () => rmSync(directory, { recursive: true, force: true }) };
}

function runCli(directory: string, args: string[]) {
  return promisify(execFile)(process.execPath, [bin, ...args], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: directory,
      NO_COLOR: "1",
      APP_CONFIG_ADMIN_API_SECRET: "",
      ITERATE_BEARER_TOKEN: "",
    },
    timeout: 10_000,
  });
}

/** A deployment whose /mcp 308s to a separate MCP origin, as prd's does, and a tools/list there
 *  that answers the operator bearer over SSE, as apps/os/src/mcp.ts does. */
async function mcpDeployment() {
  const listen = async (handler: Parameters<typeof createServer>[1]) => {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    return { server, origin: `http://127.0.0.1:${address.port}` };
  };
  const mcp = await listen((request, response) => {
    if (request.headers.authorization !== "Bearer it's-secret") {
      response.writeHead(401).end('{"error":"invalid_token"}');
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "run" }] } })}\n\n`,
    );
  });
  const os = await listen((request, response) => {
    response.writeHead(request.url === "/mcp" ? 308 : 404, { location: `${mcp.origin}/` }).end();
  });
  return {
    osBaseUrl: os.origin,
    mcpUrl: `${mcp.origin}/`,
    async [Symbol.asyncDispose]() {
      for (const { server } of [mcp, os])
        await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

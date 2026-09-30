// provide.test.ts — `iterate provide <file>` as a person runs it (the package's bin) against a
// capnweb server shaped like the platform's `/api`: a .ts, a .mjs and a CommonJS .js file each
// loaded by Node itself, their bare imports resolved from their own folder, their functions lent at
// itx.<name> and called back through the lent stub, the itx they were handed reaching the project;
// a missing dependency named before any sign-in; and `runProvide` lending again over each new
// connection. The platform half (the lend through a deployment) is core/os e2e/provide.e2e.test.ts.
import { tmpdir } from "node:os";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync, mkdtempDisposableSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { newWebSocketRpcSession, RpcTarget, type RpcStub } from "capnweb";
import { WebSocketServer } from "ws";
import { expect, test, vi } from "vitest";
import { rpcTargetOf, runProvide } from "./provide.ts";

const bin = fileURLToPath(new URL("../../bin/iterate.js", import.meta.url));

test(
  "a .ts, a .mjs and a CommonJS .js file are each lent as itx.<name>: a call reaches the file, which reaches the project through its itx; description goes with the lend; Ctrl-C exits 0",
  { timeout: 30_000 },
  async () => {
    await using deployment = await fakeDeployment();
    using folder = mkdtempDisposableSync(join(tmpdir(), "iterate-test-"));
    // the file's folder is a package with its own dependency, which this CLI does not have
    writeFileSync(join(folder.path, "package.json"), JSON.stringify({ type: "module" }));
    mkdirSync(join(folder.path, "node_modules/greeting"), { recursive: true });
    writeFileSync(
      join(folder.path, "node_modules/greeting/package.json"),
      JSON.stringify({ name: "greeting", type: "module", exports: "./index.js" }),
    );
    writeFileSync(
      join(folder.path, "node_modules/greeting/index.js"),
      `export const hello = "Hello";`,
    );
    writeFileSync(
      join(folder.path, "greeter.ts"),
      `import { hello } from "greeting";
      type Itx = { append(event: { type: string; payload: unknown }): Promise<unknown> };
      export const description = "Greets people, from TypeScript";
      let calls = 0; // module scope: the file's, for the whole process
      export default function provide({ itx }: { itx: Itx }) {
        return {
          async greet(name: string): Promise<string> {
            calls += 1;
            await itx.append({ type: "greeted", payload: { name, calls } });
            return \`\${hello}, \${name} (ts)\`;
          },
          bytes: () => new Uint8Array([1, 2, 3]),
          notAFunction: 42,
        };
      }`,
    );
    // a class instance: its methods are lent, its fields are not
    writeFileSync(
      join(folder.path, "classy.mjs"),
      `import { hello } from "greeting";
      class Greeter {
        constructor(itx) { this.itx = itx; }
        async greet(name) {
          await this.itx.append({ type: "greeted", payload: { name } });
          return \`\${hello}, \${name} (mjs)\`;
        }
      }
      export default ({ itx }) => new Greeter(itx);`,
    );
    mkdirSync(join(folder.path, "commonjs"));
    writeFileSync(join(folder.path, "commonjs/package.json"), JSON.stringify({ type: "commonjs" }));
    writeFileSync(
      join(folder.path, "commonjs/plain.js"),
      `module.exports = () => ({ greet: (name) => "Hi, " + name + " (cjs)" });`,
    );
    using cli = cliConfig(deployment.url);

    const ts = cli.provide([join(folder.path, "greeter.ts"), "--project", "demo"]);
    expect(await ts.live).toBe("itx.greeter");
    const greeter = deployment.lent.get("itx.greeter")!;
    expect(greeter).toMatchObject({ options: { description: "Greets people, from TypeScript" } });
    expect(await greeter.stub.greet("Jonas")).toBe("Hello, Jonas (ts)");
    // bytes cross as bytes (a Buffer on this side, Node's)
    expect([...((await greeter.stub.bytes()) as Uint8Array)]).toEqual([1, 2, 3]);
    await expect(greeter.stub.notAFunction()).rejects.toThrow();
    expect(deployment).toMatchObject({
      appended: [{ type: "greeted", payload: { name: "Jonas", calls: 1 } }],
    });
    expect(await ts.stop()).toBe(0);

    const mjs = cli.provide([
      join(folder.path, "classy.mjs"),
      "--name",
      "classy.greeter",
      "--project",
      "demo",
    ]);
    expect(await mjs.live).toBe("itx.classy.greeter");
    const classy = deployment.lent.get("itx.classy.greeter")!;
    expect(classy.options).toBeUndefined();
    expect(await classy.stub.greet("Misha")).toBe("Hello, Misha (mjs)");
    await expect(classy.stub.itx()).rejects.toThrow();
    expect(deployment.appended.at(-1)).toEqual({ type: "greeted", payload: { name: "Misha" } });
    expect(await mjs.stop()).toBe(0);

    const cjs = cli.provide([join(folder.path, "commonjs/plain.js"), "--project", "demo"]);
    expect(await cjs.live).toBe("itx.plain");
    expect(await deployment.lent.get("itx.plain")!.stub.greet("Nick")).toBe("Hi, Nick (cjs)");
    expect(await cjs.stop()).toBe(0);
  },
);

test("a file whose dependency is not installed names the folder to install in, before any sign-in; a file with no default export says what to export", async () => {
  using temporary = mkdtempDisposableSync(join(tmpdir(), "iterate-test-"));
  // Node names the file by its real path (macOS's temp dir is a symlink into /private)
  const folder = { path: realpathSync(temporary.path) };
  writeFileSync(join(folder.path, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(folder.path, "whatsapp.ts"),
    `import "baileys-not-installed"; export default () => ({});`,
  );
  writeFileSync(join(folder.path, "nothing.mjs"), `export const x = 1;`);
  // nothing listens here: the file's refusal must come first
  using cli = cliConfig("http://127.0.0.1:1");

  const missing = cli.provide([join(folder.path, "whatsapp.ts"), "--project", "demo"]);
  expect(await missing.exited).not.toBe(0);
  expect(missing.stderr()).toContain(
    `Cannot find package 'baileys-not-installed' imported from ${join(folder.path, "whatsapp.ts")}. Install whatsapp.ts's dependencies first: npm install (or pnpm install) in ${folder.path}.`,
  );

  const empty = cli.provide([join(folder.path, "nothing.mjs"), "--project", "demo"]);
  expect(await empty.exited).not.toBe(0);
  expect(empty.stderr()).toContain("nothing.mjs has no default export to provide");
});

// The reconnect lifecycle `runProvide` documents (./provide.ts).
test("runProvide: every connection calls the default export with its own project and lends again; no reconnect left ends it", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  const lends: { project: string; match: string; options: unknown; target: unknown }[] = [];
  const given: unknown[] = [];
  const connection = (name: string, closed: Promise<{ code: number; reason: string }>) =>
    ({
      session: {
        projects: {
          get: async () => ({
            name,
            provide: async (match: string, target: unknown, options: unknown) => {
              lends.push({ project: name, match, options, target });
              return { lendEnded: () => new Promise<string>(() => {}), [Symbol.dispose]: () => {} };
            },
            [Symbol.dispose]: () => {},
          }),
        },
      },
      closed,
      [Symbol.dispose]: () => {},
    }) as unknown as Parameters<typeof runProvide>[0]["connection"];
  let reconnects = 0;
  const run = runProvide({
    connection: connection("first", Promise.resolve({ code: 1006, reason: "" })),
    reconnect: async () => {
      reconnects += 1;
      if (reconnects > 1) throw new Error("offline");
      return connection("second", Promise.resolve({ code: 1006, reason: "" }));
    },
    reconnectDelaysMs: [0, 0],
    project: "demo",
    file: {
      provide: ({ itx }) => {
        given.push((itx as { name: string }).name);
        return { ping: () => "pong" };
      },
      description: "a pinger",
    },
    name: "pinger",
  });
  await expect(run).rejects.toThrow(
    "itx.pinger disconnected and could not reconnect (offline). Run iterate provide again.",
  );
  expect(given).toEqual(["first", "second"]);
  expect(lends).toMatchObject([
    { project: "first", match: "itx.pinger", options: { description: "a pinger" } },
    { project: "second", match: "itx.pinger", options: { description: "a pinger" } },
  ]);
  expect(lends[0]!.target).toBeInstanceOf(RpcTarget);
  expect(stdout.mock).toMatchObject({ calls: [["itx.pinger"]] });
});

test("rpcTargetOf: nothing to lend is refused, saying why", () => {
  expect(() => rpcTargetOf(undefined)).toThrow(
    "The default export answered undefined: it must answer an object of functions.",
  );
  expect(() => rpcTargetOf({ answer: 42 })).toThrow(
    "The default export answered an object with no functions: nothing to lend.",
  );
});

/** A capnweb server shaped like the platform's `/api` for `provide`: `authenticate`, then
 *  `projects.get` answers a project whose `provide` keeps the lent stub and whose `append` keeps
 *  the events. */
async function fakeDeployment() {
  const lent = new Map<
    string,
    { stub: RpcStub<Record<string, (...args: unknown[]) => unknown>>; options: unknown }
  >();
  const appended: unknown[] = [];
  class LendHandle extends RpcTarget {
    lendEnded() {
      return new Promise<string>(() => {});
    }
  }
  class Project extends RpcTarget {
    provide(
      match: string,
      stub: RpcStub<Record<string, (...args: unknown[]) => unknown>>,
      options?: unknown,
    ) {
      // a stub passed in is capnweb's to dispose when the call returns, unless kept with dup()
      lent.set(match, { stub: stub.dup(), options });
      return new LendHandle();
    }
    append(...events: unknown[]) {
      appended.push(...events);
      return { offset: appended.length };
    }
  }
  class Session extends RpcTarget {
    get projects() {
      return { get: () => new Project() };
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
  return {
    url: `http://127.0.0.1:${address.port}`,
    lent,
    appended,
    [Symbol.asyncDispose]: async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A config naming `baseUrl` with a stored token, and `provide` run as a child process: `live`
 *  answers the line it prints once lent, `stop` sends Ctrl-C and answers the exit code. */
function cliConfig(baseUrl: string) {
  const config = mkdtempDisposableSync(join(tmpdir(), "iterate-test-"));
  mkdirSync(join(config.path, "iterate"));
  writeFileSync(
    join(config.path, "iterate/config.json"),
    JSON.stringify({
      default: "test",
      configs: { test: { osBaseUrl: baseUrl, session: { token: "test-token" } } },
    }),
  );
  const children: ChildProcess[] = [];
  return {
    provide(args: string[]) {
      const child = execFile(process.execPath, [bin, "provide", ...args], {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: config.path,
          NO_COLOR: "1",
          APP_CONFIG_SECRETS__ADMIN_BEARER: "",
          ITERATE_BEARER_TOKEN: "",
        },
      });
      children.push(child);
      let stderr = "";
      child.stderr!.on("data", (chunk) => (stderr += chunk));
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      const live = new Promise<string>((resolve, reject) => {
        createInterface({ input: child.stdout! }).once("line", resolve);
        void exited.then((code) =>
          reject(new Error(`iterate provide exited ${code} before it was live: ${stderr}`)),
        );
      });
      live.catch(() => {}); // a file refused before it was live is read through `exited`
      return {
        live,
        exited,
        stderr: () => stderr,
        stop: () => {
          child.kill("SIGINT");
          return exited;
        },
      };
    },
    [Symbol.dispose]: () => {
      for (const child of children) child.kill("SIGKILL");
      config[Symbol.dispose]();
    },
  };
}

// bare-workerd-test-support.ts — a bare workerd (the binary wrangler runs) serving one fixture, for
// the rows that read workerd's own log: the runtime's uncaught errors, which neither the Workers
// suite nor wrangler's harness shows.

import { tmpdir } from "node:os";
import { mkdtempDisposableSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";
import { expect, vi } from "vitest";
import { COMPATIBILITY_DATE } from "iterate/compatibility-date";

/** `fixture` (a module whose imports resolve from `resolveDir`) served by a bare workerd on a free
 *  port as the service `main`, `--verbose` so its log names every invocation that failed. `worker`
 *  is more of the worker's capnp fields (bindings, Durable Object namespaces). The fixture answers
 *  a plain GET of `/` once it is up. `settledLog` waits out the invocations' ends and returns the
 *  log's lines, the worker's console among them. */
export async function bareWorkerd(options: {
  fixture: string;
  resolveDir: string;
  worker?: string;
}) {
  const port = await freePort();
  const directory = mkdtempDisposableSync(join(tmpdir(), "iterate-test-"));
  const dir = directory.path;
  const bundle = await build({
    stdin: { contents: options.fixture, resolveDir: options.resolveDir },
    bundle: true,
    format: "esm",
    external: ["cloudflare:*"],
    write: false,
  });
  await writeFile(join(dir, "worker.js"), bundle.outputFiles[0]!.text);
  await writeFile(
    join(dir, "config.capnp"),
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "main", worker = (
    modules = [ (name = "worker.js", esModule = embed "worker.js") ],
    compatibilityDate = "${COMPATIBILITY_DATE}",
    ${options.worker || ""}
  )) ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "main") ],
);`,
  );
  const binary: string = createRequire(createRequire(import.meta.url).resolve("wrangler"))(
    "workerd",
  ).default;
  const child: ChildProcess = spawn(binary, ["serve", join(dir, "config.capnp"), "--verbose"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout!.on("data", (chunk) => (log += chunk));
  child.stderr!.on("data", (chunk) => (log += chunk));
  await vi.waitFor(
    async () => expect(await fetch(`http://127.0.0.1:${port}/`)).toMatchObject({ ok: true }),
    { timeout: 15_000, interval: 100 },
  );
  return {
    http: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}`,
    async settledLog() {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return log.split("\n");
    },
    async [Symbol.asyncDispose]() {
      child.kill();
      directory[Symbol.dispose]();
    },
  };
}

/** A line of workerd's log naming an invocation that failed. */
export function isUncaught(line: string): boolean {
  return line.includes("uncaught exception");
}

/** A port nothing listens on: the OS's pick for a listener closed at once. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

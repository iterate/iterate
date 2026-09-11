/** Local-only celld runner. Build both real Workers, publish the compiler first, then run the
 * application and its unchanged public E2E tests. Every invocation owns an isolated local store. */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import JSON5 from "json5";
import { z } from "zod";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const [mode, ...testArgs] = process.argv.slice(2);
if (mode !== "dev" && mode !== "test")
  throw new Error("Usage: tsx scripts/celld.ts dev|test [vitest arguments]");
const binary = process.env.CELLD_BIN || "celld";
if (process.platform === "win32")
  throw new Error("This local celld runner requires POSIX process groups");
const children = new Set<ChildProcess>();
// Isolate children from terminal Ctrl-C: receiving both the terminal's signal and our forwarded
// signal can interrupt celld's own server cleanup. The CLI supervises a separate server group.
function signalGroup(child: ChildProcess, signal: NodeJS.Signals | 0): boolean {
  if (!child.pid) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    interrupted = true;
    for (const child of children) signalGroup(child, "SIGINT");
  });

async function command(binary: string, args: string[], env = process.env) {
  if (interrupted) throw new Error("Interrupted");
  const child = spawn(binary, args, { cwd: packageDir, stdio: "inherit", env, detached: true });
  children.add(child);
  try {
    const [code] = await once(child, "exit");
    if (code !== 0) throw new Error(`${binary} exited with ${code}`);
  } finally {
    await stop(child);
  }
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local TCP port allocated");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function stop(child: ChildProcess) {
  try {
    if (!signalGroup(child, "SIGINT")) return;
    // Celld itself allows 2s for the shutdown request plus 35s to reap its server. Let that
    // supervision finish before force-stopping the CLI, particularly on macOS (no PDEATHSIG).
    const deadline = Date.now() + 45_000;
    while (signalGroup(child, 0)) {
      if (Date.now() >= deadline) {
        console.error(`Process group ${child.pid} did not stop within 45s; forcing termination`);
        process.exitCode = 1;
        signalGroup(child, "SIGKILL");
        return;
      }
      await delay(100);
    }
  } finally {
    children.delete(child);
  }
}

const Config = z.looseObject({
  name: z.string(),
  main: z.string(),
  assets: z.looseObject({ directory: z.string() }).optional(),
  vars: z.record(z.string(), z.string()).optional(),
});

await mkdir(join(packageDir, ".celld"), { recursive: true });
const runDir = await mkdtemp(join(packageDir, ".celld", "run-"));
console.info(`celld artifacts, state and logs: ${runDir}`);

async function start(config: string, port: number, label: string) {
  if (interrupted) throw new Error("Interrupted");
  const child = spawn(binary, ["dev", config, "--port", String(port), "--no-watch", "--logs"], {
    cwd: packageDir,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: {
      ...process.env,
      NO_COLOR: "1",
      CELLD_WORKER_LOADER: "LOADER",
      RUST_LOG: "warn,cell_console=info",
    },
  });
  children.add(child);
  const log = createWriteStream(join(runDir, `${label}.log`));
  let tail = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} did not become ready within 45s\n${tail}`)),
      45_000,
    );
    const output = (chunk: Buffer) => {
      log.write(chunk);
      tail = (tail + chunk.toString()).slice(-16_000);
      if (tail.includes(`ready  http://127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", output);
    child.stderr.on("data", output);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      log.end();
      reject(new Error(`${label} exited (${code ?? signal})\n${tail}`));
    });
  });
  return child;
}

try {
  const { stdout } = await promisify(execFile)(binary, ["--version"], { timeout: 10_000 });
  const runtimeVersion = stdout.trim();
  console.info(runtimeVersion);
  await command(process.execPath, ["build-sdk.mjs"]);
  const hash = createHash("sha256");
  const assetsDir = join(runDir, "public");
  await cp(join(packageDir, "public"), assetsDir, { recursive: true });
  const assets = await readdir(assetsDir, { recursive: true, withFileTypes: true });
  for (const asset of assets
    .filter((entry) => entry.isFile())
    .sort((a, b) => join(a.parentPath, a.name).localeCompare(join(b.parentPath, b.name)))) {
    const path = join(asset.parentPath, asset.name);
    hash.update(relative(assetsDir, path));
    hash.update(await readFile(path));
  }
  const configs = [];
  for (const [label, template, entry] of [
    ["bundler", "wrangler.celld-bundler.jsonc", "src/bundler.ts"],
    ["main", "wrangler.celld.jsonc", "src/worker.ts"],
  ]) {
    const config = Config.parse(JSON5.parse(await readFile(join(packageDir, template), "utf8")));
    const built = await build({
      absWorkingDir: packageDir,
      entryPoints: [entry],
      outdir: join(runDir, label),
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2024",
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:*", "node:*"],
      // The browser build of esbuild-wasm uses the standard Worker global alias `self`.
      // Capture the host global outside esbuild-wasm's own local `globalThis` object.
      banner: { js: "const __celldWorkerGlobal = globalThis;" },
      define: { "process.browser": "true", self: "__celldWorkerGlobal" },
      loader: { ".wasm": "copy" },
      metafile: true,
      // worker-bundler eagerly imports its compiled WASM using import(). Celld loads compiled
      // WASM through static imports only. Bundle an ordinary JS namespace around that import;
      // esbuild keeps the caller's Promise semantics and emits the real WASM as a sibling module.
      plugins: [
        {
          name: "celld-static-wasm",
          setup(bundler) {
            bundler.onResolve({ filter: /\.wasm$/ }, (args) =>
              args.kind === "dynamic-import"
                ? { path: resolve(args.resolveDir, args.path), namespace: "celld-static-wasm" }
                : undefined,
            );
            bundler.onLoad({ filter: /.*/, namespace: "celld-static-wasm" }, (args) => ({
              contents: `import wasm from ${JSON.stringify(args.path)}; export default wasm;`,
              loader: "js",
              resolveDir: dirname(args.path),
            }));
          },
        },
      ],
    });
    for (const output of Object.keys(built.metafile.outputs).sort()) {
      hash.update(label + "/" + basename(output));
      hash.update(await readFile(resolve(packageDir, output)));
    }
    hash.update(JSON.stringify(config));
    configs.push({
      label,
      config: {
        ...config,
        main: `${label}/${basename(entry, ".ts")}.js`,
        ...(config.assets && { assets: { ...config.assets, directory: "public" } }),
      },
    });
  }
  const deploymentId = hash.digest("hex");
  for (const { label, config } of configs)
    await writeFile(
      join(runDir, `${label}.json`),
      JSON.stringify(
        {
          ...config,
          vars: { ...config.vars, DEPLOYMENT_ID: deploymentId },
        },
        null,
        2,
      ),
    );
  await writeFile(
    join(runDir, "run.json"),
    JSON.stringify({ deploymentId, binary, runtimeVersion, mode, testArgs }, null, 2),
  );

  // Both configs share this run's local store. Stop the compiler's dev node after publishing its
  // named manifest; the application node loads the real compiler as a separate service isolate.
  const compiler = await start(join(runDir, "bundler.json"), await freePort(), "bundler");
  await stop(compiler);
  const port = await freePort();
  const app = await start(join(runDir, "main.json"), port, "main");
  const url = `http://127.0.0.1:${port}`;
  const version = await fetch(`${url}/version`, { signal: AbortSignal.timeout(5000) });
  const versionText = await version.text();
  if (!version.ok || !versionText.trim().endsWith(deploymentId))
    throw new Error(`Wrong Worker identity: ${versionText}`);
  console.info(`V4 on celld: ${url} (${deploymentId})`);
  if (mode === "dev") {
    const [code] = await once(app, "exit");
    if (code !== 0 && !interrupted) throw new Error(`celld exited with ${code}`);
  } else {
    await command(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        "e2e/vitest.celld.config.ts",
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${join(runDir, "tests.json")}`,
        ...testArgs,
      ],
      { ...process.env, WORKER_BASE_URL: url },
    );
  }
} catch (error) {
  console.error(error);
  process.exitCode = interrupted ? 130 : 1;
} finally {
  await Promise.all([...children].map(stop));
}

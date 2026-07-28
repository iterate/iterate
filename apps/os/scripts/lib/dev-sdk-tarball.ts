/**
 * Local-dev lockstep for the `iterate` SDK.
 *
 * WHY THIS EXISTS: dynamic worker builds (the seeded template apps included)
 * npm-install the `iterate` package from the spec in the template's
 * package.json — published `iterate@main` by default. Preview deploys pin
 * that spec's ref to the PR head's published build
 * (APP_CONFIG_ITERATE_REPO_PKG_REF in deploy.ts), so preview e2e always
 * tests template + SDK in lockstep. Local dev had no such override: a branch
 * that adds an SDK export and uses it from template code was silently broken
 * under plain `pnpm dev` — the template built against yesterday's @main,
 * failed in a background worker build, and the page just sat on the
 * "building" overlay. (Exactly how this branch's createProcessorHost
 * regression hid.) These two halves give local dev preview's semantics: the
 * `iterate` dependency points at THIS worktree's packed SDK, via the
 * name-keyed APP_CONFIG_ITERATE_REPO_PKG_SPEC_OVERRIDES map (a ref cannot
 * express a local tarball, and name-keying re-points repos still carrying a
 * stale tarball URL from before an SDK edit).
 *
 * HOW THE PIECES FIT (the ordering is load-bearing):
 *
 * - `packLocalIterateSdk` runs in dev.ts — the PARENT process — before the
 *   server spawns. It builds packages/iterate, packs it into a
 *   content-named tarball under .dev-server/sdk, picks a free loopback port,
 *   and returns the finished spec URL. dev.ts then exports
 *   APP_CONFIG_ITERATE_REPO_PKG_SPEC_OVERRIDES (+ ITERATE_DEV_SDK_TARBALL)
 *   into the child's environment. Setting the overrides in the parent is NOT
 *   an implementation detail: generate-wrangler-config.ts reads process.env
 *   in module-level constants, which ES import hoisting evaluates before any
 *   code in vite.config.ts runs — an env var set inside the vite process
 *   would be captured too late and silently never reach the worker's vars.
 *
 * - `serveDevSdkTarball` runs at the top of vite.config.ts — the CHILD
 *   process, which owns the long-lived server — and binds the pre-chosen
 *   port from the overridden spec URL, serving the one tarball file.
 *   worker-bundler installs direct HTTP(S) tarball URLs, so no registry is
 *   involved. Bound to 127.0.0.1 explicitly ("localhost" can resolve to ::1
 *   and break the workerd-side dial).
 *
 * - The tarball name carries a content hash of the BUILT package (dist +
 *   manifest, not the tarball bytes — pack embeds mtimes, which would rotate
 *   the name every restart). The spec URL participates in dynamic-worker
 *   build keys, so an unchanged SDK keeps its build cache across dev
 *   restarts and any SDK change is a new spec → a fresh build, never a stale
 *   cached artifact.
 *
 * An explicit APP_CONFIG_ITERATE_REPO_PKG_SPEC_OVERRIDES in the environment
 * wins: dev.ts skips all of this so a developer can pin any published build.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { createReadStream, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/** Build + pack the workspace `iterate` package and reserve a loopback port;
 * returns the spec URL for the child environment. Parent-process half. */
export async function packLocalIterateSdk(
  appRoot: string,
): Promise<{ specUrl: string; tarball: string }> {
  const packageRoot = path.resolve(appRoot, "../../packages/iterate");
  const outDir = path.resolve(appRoot, ".dev-server/sdk");
  mkdirSync(outDir, { recursive: true });

  run("pnpm", ["--dir", packageRoot, "build"], appRoot);

  const distDir = path.join(packageRoot, "dist");
  const hash = createHash("sha256");
  for (const file of readdirSync(distDir, { recursive: true }).sort()) {
    const absolute = path.join(distDir, String(file));
    if (!statSync(absolute).isFile()) continue;
    hash.update(String(file));
    hash.update(readFileSync(absolute));
  }
  hash.update(readFileSync(path.join(packageRoot, "package.json")));
  const tarball = path.join(outDir, `iterate-${hash.digest("hex").slice(0, 12)}.tgz`);

  const existing = readdirSync(outDir).filter((name) => name.endsWith(".tgz"));
  if (!existing.includes(path.basename(tarball))) {
    run("pnpm", ["--dir", packageRoot, "pack", "--out", tarball], appRoot);
  }
  for (const name of existing) {
    if (name !== path.basename(tarball)) rmSync(path.join(outDir, name), { force: true });
  }

  const port = await pickFreePort();
  return { specUrl: `http://127.0.0.1:${port}/${path.basename(tarball)}`, tarball };
}

/** Serve the packed tarball on the port dev.ts baked into the override spec
 * URL. Child-process (vite.config.ts) half; no-op without the dev.ts env. */
export async function serveDevSdkTarball(): Promise<void> {
  const tarball = process.env.ITERATE_DEV_SDK_TARBALL;
  const overrides = process.env.APP_CONFIG_ITERATE_REPO_PKG_SPEC_OVERRIDES;
  if (!tarball || !overrides) return;
  // The loopback URL among the override specs is the tarball dev.ts packed;
  // an explicit developer-provided overrides map may not carry one.
  const spec = Object.values(JSON.parse(overrides) as Record<string, string>).find(
    (candidate) => URL.canParse(candidate) && new URL(candidate).hostname === "127.0.0.1",
  );
  if (!spec) return;
  const url = new URL(spec);

  // Vite re-evaluates this config module on change; keep one server per
  // process (the port is taken after the first listen).
  const key = "__iterateDevSdkTarballServer";
  const globals = globalThis as { [key]?: true };
  if (globals[key]) return;
  const server = createServer((request, response) => {
    if (request.url !== url.pathname) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    createReadStream(tarball).pipe(response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) =>
      reject(
        new Error(
          `dev sdk tarball server failed to bind ${url.host} — restart pnpm dev (${String(error)})`,
        ),
      ),
    );
    server.listen(Number(url.port), "127.0.0.1", resolve);
  });
  // The server must not keep the vite process alive on its own.
  server.unref();
  globals[key] = true;
  console.log(`[dev] dynamic worker builds pinned to local iterate sdk: ${spec}`);
}

async function pickFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        reject(new Error("could not reserve a port for the dev sdk tarball server"));
      }
    });
  });
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr || result.stdout}`,
    );
  }
}

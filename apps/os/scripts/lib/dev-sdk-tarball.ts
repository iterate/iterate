/**
 * Local-dev lockstep for this repo's published packages.
 *
 * WHY THIS EXISTS: dynamic worker builds (the seeded template apps included)
 * npm-install the `iterate` package — and the `@iterate-com/docs` config
 * bridge — from the specs in the template's package.json: published `@main`
 * by default. Preview deploys pin those specs' ref to the PR head's published
 * build (APP_CONFIG_ITERATE_REPO_PKG_REF in deploy.ts), so preview e2e always
 * tests template + packages in lockstep. Local dev had no such override: a
 * branch that adds an SDK export and uses it from template code was silently
 * broken under plain `pnpm dev` — the template built against yesterday's
 * @main, failed in a background worker build, and the page just sat on the
 * "building" overlay. (Exactly how this branch's createProcessorHost
 * regression hid; a docs-bridge fix was equally invisible until the bridge
 * joined this list.) These two halves give local dev preview's semantics:
 * each dependency points at THIS worktree's packed package, via the
 * name-keyed APP_CONFIG_ITERATE_REPO_PKG_SPEC_OVERRIDES map (a ref cannot
 * express a local tarball, and name-keying re-points repos still carrying a
 * stale tarball URL from before an edit).
 *
 * HOW THE PIECES FIT (the ordering is load-bearing):
 *
 * - `packLocalPackages` runs in dev.ts — the PARENT process — before the
 *   server spawns. It builds and packs every package in LOCAL_PACKAGES into
 *   content-named tarballs under .dev-server/sdk, picks a free loopback
 *   port, and returns the finished spec URLs. dev.ts then exports
 *   APP_CONFIG_ITERATE_REPO_PKG_SPEC_OVERRIDES (+ ITERATE_DEV_SDK_TARBALL_DIR)
 *   into the child's environment. Setting the overrides in the parent is NOT
 *   an implementation detail: generate-wrangler-config.ts reads process.env
 *   in module-level constants, which ES import hoisting evaluates before any
 *   code in vite.config.ts runs — an env var set inside the vite process
 *   would be captured too late and silently never reach the worker's vars.
 *
 * - `serveDevSdkTarball` runs at the top of vite.config.ts — the CHILD
 *   process, which owns the long-lived server — and binds the pre-chosen
 *   port from the overridden spec URLs, serving the tarballs by file name.
 *   worker-bundler installs direct HTTP(S) tarball URLs, so no registry is
 *   involved. Bound to 127.0.0.1 explicitly ("localhost" can resolve to ::1
 *   and break the workerd-side dial).
 *
 * - Each tarball name carries a content hash of the BUILT package (dist +
 *   manifest, not the tarball bytes — pack embeds mtimes, which would rotate
 *   the name every restart). The spec URL participates in dynamic-worker
 *   build keys, so an unchanged package keeps its build cache across dev
 *   restarts and any change is a new spec → a fresh build, never a stale
 *   cached artifact.
 *
 * An explicit APP_CONFIG_ITERATE_REPO_PKG_SPEC_OVERRIDES in the environment
 * wins: dev.ts skips all of this so a developer can pin any published build.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * The workspace packages the seeded config-repo templates install by name.
 * `build` is the pnpm script that produces `dist` (hashed for the tarball
 * name); `pnpm pack` then honors each package's own `files`/publishConfig.
 */
const LOCAL_PACKAGES = [
  { build: "build", dist: "dist", name: "iterate", root: "../../packages/iterate" },
  { build: "build:package", dist: "dist-package", name: "@iterate-com/docs", root: "../docs" },
] as const;

/** Build + pack every local package and reserve a loopback port; returns
 * the name-keyed spec URLs for the child environment. Parent-process half. */
export async function packLocalPackages(
  appRoot: string,
): Promise<{ dir: string; overrides: Record<string, string> }> {
  const outDir = path.resolve(appRoot, ".dev-server/sdk");
  mkdirSync(outDir, { recursive: true });
  const existing = readdirSync(outDir).filter((name) => name.endsWith(".tgz"));

  const tarballs: string[] = [];
  for (const pkg of LOCAL_PACKAGES) {
    const packageRoot = path.resolve(appRoot, pkg.root);
    run("pnpm", ["--dir", packageRoot, pkg.build], appRoot);

    const distDir = path.join(packageRoot, pkg.dist);
    const hash = createHash("sha256");
    for (const file of readdirSync(distDir, { recursive: true }).sort()) {
      const absolute = path.join(distDir, String(file));
      if (!statSync(absolute).isFile()) continue;
      hash.update(String(file));
      hash.update(readFileSync(absolute));
    }
    hash.update(readFileSync(path.join(packageRoot, "package.json")));
    const stem = pkg.name.replace(/^@/, "").replaceAll("/", "-");
    const tarball = path.join(outDir, `${stem}-${hash.digest("hex").slice(0, 12)}.tgz`);
    if (!existing.includes(path.basename(tarball))) {
      run("pnpm", ["--dir", packageRoot, "pack", "--out", tarball], appRoot);
    }
    tarballs.push(tarball);
  }
  for (const name of existing) {
    if (!tarballs.some((tarball) => path.basename(tarball) === name)) {
      rmSync(path.join(outDir, name), { force: true });
    }
  }

  const port = await pickFreePort();
  const overrides = Object.fromEntries(
    LOCAL_PACKAGES.map((pkg, index) => [
      pkg.name,
      `http://127.0.0.1:${port}/${path.basename(tarballs[index]!)}`,
    ]),
  );
  return { dir: outDir, overrides };
}

/** Serve the packed tarballs on the port dev.ts baked into the override spec
 * URLs. Child-process (vite.config.ts) half; no-op without the dev.ts env. */
export async function serveDevSdkTarball(): Promise<void> {
  const dir = process.env.ITERATE_DEV_SDK_TARBALL_DIR;
  const overrides = process.env.APP_CONFIG_ITERATE_REPO_PKG_SPEC_OVERRIDES;
  if (!dir || !overrides) return;
  // The env var is dev.ts's own JSON.stringify of packLocalPackages's
  // overrides — package name → spec string — and a hand-set value follows
  // the same APP_CONFIG contract (the app parses it as that map). The
  // loopback URLs among the specs are the tarballs dev.ts packed (one port
  // for all); an explicit developer-provided map may not carry any.
  const specs = Object.values(JSON.parse(overrides) as Record<string, string>).filter(
    (candidate) => URL.canParse(candidate) && new URL(candidate).hostname === "127.0.0.1",
  );
  const spec = specs[0];
  if (spec === undefined) return;
  const url = new URL(spec);

  // Vite re-evaluates this config module on change; keep one server per
  // process (the port is taken after the first listen).
  const key = "__iterateDevSdkTarballServer";
  const globals = globalThis as { [key]?: true };
  if (globals[key]) return;
  const server = createServer((request, response) => {
    // Basename only: the served set is exactly the packed tarballs, never a
    // path walk out of the directory.
    const name = path.basename(request.url ?? "");
    const tarball = path.join(dir, name);
    if (!name.endsWith(".tgz") || !existsSync(tarball)) {
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
  console.log(`[dev] dynamic worker builds pinned to local packages: ${specs.join(", ")}`);
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

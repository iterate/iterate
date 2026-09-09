/** Throwaway, real-container proof. Run with `pnpm cli workspace-sandbox-prototype proof`. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { RpcStub } from "capnweb";
import { createAdminOsItx } from "../e2e/test-support/os-client.ts";
import type { SandboxBasicDurableObject } from "../src/domains/sandboxes/cloudflare/cloudflare-sandbox-durable-object.ts";

function gracefulClose(connection: Disposable, closed: Promise<unknown>): AsyncDisposable {
  return {
    async [Symbol.asyncDispose]() {
      connection[Symbol.dispose]();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("itx close handshake timed out")), 5_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

const source = new URL("../sandbox/workspace-prototype/", import.meta.url);

async function install(sandbox: RpcStub<SandboxBasicDurableObject>) {
  execFileSync(
    "go",
    ["build", "-trimpath", "-ldflags=-s -w", "-o", "/tmp/workspace-prototype-fuse", "."],
    {
      cwd: fileURLToPath(source),
      env: { ...process.env, GOOS: "linux", GOARCH: "amd64", CGO_ENABLED: "0" },
      stdio: "inherit",
    },
  );
  const binary = await readFile("/tmp/workspace-prototype-fuse");
  const runner = await readFile(new URL("run.mjs", source), "utf8");
  const version = createHash("sha256").update(binary).update(runner).digest("hex");
  const installed = await sandbox.exec(
    "if test -f /tmp/iterate-workspace-prototype/version; then cat /tmp/iterate-workspace-prototype/version; fi",
    { timeout: 30_000 },
  );
  assert.equal(installed.exitCode, 0, installed.stderr);
  if (installed.stdout === version) return;
  await sandbox.mkdir("/tmp/iterate-workspace-prototype", { recursive: true });
  await sandbox.writeFile("/tmp/iterate-workspace-prototype/fuse", binary.toString("base64"), {
    encoding: "base64",
  });
  await sandbox.writeFile("/tmp/iterate-workspace-prototype/run.mjs", runner);
  const result = await sandbox.exec("chmod +x /tmp/iterate-workspace-prototype/fuse", {
    timeout: 30_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  await sandbox.writeFile("/tmp/iterate-workspace-prototype/version", version);
}

/** Run a command against an existing workspace; the named sandbox must already exist. */
export async function run(options: {
  project: string;
  sandbox: string;
  workspacePath: string;
  under: string;
  command: string;
  localDirectories: string[];
  timeoutMs: number;
}) {
  const closed = Promise.withResolvers<void>();
  const project = createAdminOsItx({
    context: options.project,
    onWebSocketClose: () => closed.resolve(),
  });
  await using _shutdown = gracefulClose(project, closed.promise);
  // Sandbox handles intentionally forward the full installed SDK and prototype methods.
  const sandbox = (await project.sandboxes.get(
    options.sandbox,
  )) as unknown as RpcStub<SandboxBasicDurableObject>;
  await install(sandbox);
  const result = await sandbox.prototypeWorkspaceExec(options);
  console.info(JSON.stringify(result, null, 2));
  assert.equal(result.exitCode, 0, result.stderr);
  return result;
}

/** Creates an isolated fixture, checks actual state and transfer counters, then destroys its sandbox. */
export async function proof() {
  const closed = Promise.withResolvers<void>();
  const session = createAdminOsItx({ onWebSocketClose: () => closed.resolve() });
  await using _shutdown = gracefulClose(session, closed.promise);
  const slug = `workspace-prototype-${Date.now()}`;
  console.info("Creating prototype fixture", slug);
  using project = await session.projects.get(slug).create({});
  using repo = await project.repos.get("/repos/prototype").create();
  await repo.commitFiles({
    message: "Prototype fixture",
    changes: [
      { path: "source.txt", content: "committed\n" },
      { path: "remove.txt", content: "remove me\n" },
      {
        path: "package.json",
        content: JSON.stringify({
          private: true,
          dependencies: { typescript: "5.9.3", "@types/node": "24.10.1" },
        }),
      },
      ...Array.from({ length: 2_000 }, (_, index) => ({
        path: `unread/${index}.txt`,
        content: `${index}\n${"unread\n".repeat(600)}`,
      })),
    ],
  });
  using workspace = await project.workspaces.get("/workspaces/prototype").create({});
  await workspace.writeFile("/repos/prototype/source.txt", "uncommitted\n");
  await workspace.writeFile("/repos/prototype/new-in-do.txt", "private\n");
  await project.sandboxes.get("/sandboxes/prototype").create({ instanceType: "basic" });
  // As above, the runtime sandbox handle forwards prototype methods to the claimed DO.
  let sandbox = (await project.sandboxes.get(
    "/sandboxes/prototype",
  )) as unknown as RpcStub<SandboxBasicDurableObject>;
  const input = {
    workspacePath: "/workspaces/prototype",
    under: "/repos/prototype",
    localDirectories: ["node_modules"],
    timeoutMs: 180_000,
  };
  let sandboxDestroyed = false;
  try {
    console.info("Installing prototype mount");
    await install(sandbox);
    console.info("Checking metadata, source edits, and cached reads");
    const metadata = await sandbox.prototypeWorkspaceExec({
      ...input,
      command: "find . -type f | wc -l; stat -c %s unread/1999.txt",
    });
    assert.equal(metadata.exitCode, 0, metadata.stderr);
    assert.equal(metadata.metrics.readBytes, 0);
    const edit = await sandbox.prototypeWorkspaceExec({
      ...input,
      command:
        "cat source.txt new-in-do.txt; printf 'from sandbox\\n' > source.txt; printf 'created\\n' > created.txt; rm remove.txt",
    });
    assert.equal(edit.exitCode, 0, edit.stderr);
    assert.match(edit.stdout, /uncommitted\nprivate\n/);
    assert.equal(await workspace.readFile("/repos/prototype/source.txt"), "from sandbox\n");
    assert.equal(await workspace.readFile("/repos/prototype/created.txt"), "created\n");
    assert.equal(await workspace.readFile("/repos/prototype/remove.txt"), null);
    await workspace.writeFile("/repos/prototype/source.txt", "new DO version\n");
    const read = await sandbox.prototypeWorkspaceExec({ ...input, command: "cat source.txt" });
    assert.equal(read.exitCode, 0, read.stderr);
    assert.match(read.stdout, /new DO version/);
    const cached = await sandbox.prototypeWorkspaceExec({ ...input, command: "cat source.txt" });
    assert.equal(cached.exitCode, 0, cached.stderr);
    assert.equal(cached.metrics.readBytes, 0);
    console.info("Installing dependencies and creating 20,000 native files");
    const dependencies = await sandbox.prototypeWorkspaceExec({
      ...input,
      command:
        'npm install --ignore-scripts --no-audit --no-fund --package-lock=false; node -e \'const fs=require("fs"); for(let i=0;i<20000;i++)fs.writeFileSync("node_modules/generated-"+i,"local")\'; findmnt -T node_modules; node_modules/.bin/tsc --version',
    });
    assert.equal(dependencies.exitCode, 0, dependencies.stderr);
    assert.equal(dependencies.metrics.fileWrites, 0);
    assert(!(await workspace.listAllFiles()).some((path) => path.includes("/node_modules/")));
    console.info("Comparing cold/cached reads and native dependency installation");
    await sandbox.writeFile(
      "/tmp/iterate-workspace-prototype/benchmark.mjs",
      await readFile(new URL("benchmark.mjs", source), "utf8"),
    );
    const benchmark = await sandbox.prototypeWorkspaceExec({
      ...input,
      command: "node /tmp/iterate-workspace-prototype/benchmark.mjs",
    });
    console.info(JSON.stringify({ benchmark }, null, 2));
    assert.equal(benchmark.exitCode, 0, benchmark.stderr);
    assert.equal(benchmark.metrics.fileReads, 200);
    assert.equal(benchmark.metrics.fileWrites, 0);
    console.info("Discarding the container and recovering uncommitted work in a new one");
    await sandbox.destroy();
    sandboxDestroyed = true;
    assert.equal(await workspace.readFile("/repos/prototype/created.txt"), "created\n");
    await project.sandboxes.get("/sandboxes/prototype-recovery").create({ instanceType: "basic" });
    // A fresh claimed sandbox forwards the same prototype method.
    sandbox = (await project.sandboxes.get(
      "/sandboxes/prototype-recovery",
    )) as unknown as RpcStub<SandboxBasicDurableObject>;
    sandboxDestroyed = false;
    await install(sandbox);
    const recovery = await sandbox.prototypeWorkspaceExec({
      ...input,
      command: 'cat created.txt source.txt; test -z "$(ls -A node_modules)"',
    });
    assert.equal(recovery.exitCode, 0, recovery.stderr);
    assert.match(recovery.stdout, /created\nnew DO version\n/);
    const commit = await workspace.git.commit({
      scope: "/repos/prototype",
      message: "Sandbox prototype changes",
    });
    assert(commit);
    assert.equal((await repo.readFile({ path: "created.txt" }))?.content, "created\n");
    console.info(
      JSON.stringify(
        { metadata, edit, read, cached, dependencies, benchmark, recovery, commit, project: slug },
        null,
        2,
      ),
    );
  } finally {
    if (!sandboxDestroyed) await sandbox.destroy();
  }
}

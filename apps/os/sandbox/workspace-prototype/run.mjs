// Throwaway command runner. The only uploads are changed source files from the native upper.
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

const endpoint = "http://workspace.internal";
const response = await fetch(`${endpoint}/manifest`);
if (!response.ok) throw new Error(`Workspace manifest: HTTP ${response.status}`);
const input = await response.json();
const scope = createHash("sha256").update(`${input.workspacePath}\0${input.under}`).digest("hex");
const state = `/tmp/iterate-workspace-prototype/state/${scope}`;
const pending = `/workspace/.iterate-workspace-prototype/${scope}`;
await mkdir(state, { recursive: true });
const original = new Map(input.files.map((file) => [file.path, file]));
const mounts = [];
let temp, lower, merged, upper, daemon, daemonExit, daemonError;
let synchronized = false,
  pendingOwned = false,
  userCommandSpawned = false;

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}

async function unmount(path) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = spawnSync("umount", [path], { stdio: "ignore" });
    if (result.error) throw result.error;
    if (result.status === 0) return;
    await setTimeout(25);
  }
  throw new Error(`Mount remains busy after bounded cleanup: ${path}`);
}

async function stopDaemon() {
  if (!daemon || daemon.exitCode !== null || daemon.pid === undefined) return;
  daemon.kill("SIGTERM");
  if (
    !(await Promise.race([daemonExit.then(() => true), setTimeout(5_000, false, { ref: false })]))
  ) {
    throw new Error("FUSE daemon did not exit after SIGTERM");
  }
}
let overlay, overlayExit, overlayError;
async function stopOverlay() {
  if (!overlay || overlay.exitCode !== null || overlay.pid === undefined) return;
  overlay.kill("SIGTERM");
  if (
    !(await Promise.race([overlayExit.then(() => true), setTimeout(5_000, false, { ref: false })]))
  ) {
    throw new Error("Overlay daemon did not exit after SIGTERM");
  }
}
let commandError, cleanupError;
try {
  pendingOwned = (await mkdir(pending, { recursive: true })) !== undefined;
  if ((await readdir(pending)).length)
    throw new Error(
      `Unsynchronized files remain in ${pending}; recover them before another command`,
    );
  pendingOwned = true;
  temp = await mkdtemp(`${state}/run-`);
  lower = join(temp, "lower");
  merged = join(temp, "merged");
  upper = join(pending, "upper");
  for (const path of [lower, merged, upper, join(pending, "work")]) await mkdir(path);
  await writeFile(join(pending, "manifest.json"), JSON.stringify(input));
  await writeFile(join(temp, "files.json"), JSON.stringify(input.files));
  daemon = spawn(
    "/tmp/iterate-workspace-prototype/fuse",
    [
      "--manifest",
      join(temp, "files.json"),
      "--mount",
      lower,
      "--cache",
      join(state, "blobs"),
      "--url",
      endpoint,
    ],
    { stdio: "inherit" },
  );
  daemonExit = new Promise((resolve) => daemon.once("exit", resolve));
  daemon.once("error", (error) => {
    daemonError = error;
  });
  const deadline = Date.now() + 10_000;
  while (spawnSync("mountpoint", ["-q", lower]).status !== 0) {
    if (daemonError) throw daemonError;
    if (daemon.exitCode !== null || Date.now() > deadline)
      throw new Error("Lazy mount did not start");
    await setTimeout(25);
  }
  mounts.push(lower);
  overlay = spawn(
    "fuse-overlayfs",
    ["-f", "-o", `lowerdir=${lower},upperdir=${upper},workdir=${pending}/work`, merged],
    { stdio: "inherit" },
  );
  overlayExit = new Promise((resolve) => overlay.once("exit", resolve));
  overlay.once("error", (error) => {
    overlayError = error;
  });
  const overlayDeadline = Date.now() + 10_000;
  while (spawnSync("mountpoint", ["-q", merged]).status !== 0) {
    if (overlayError) throw overlayError;
    if (overlay.exitCode !== null || Date.now() > overlayDeadline)
      throw new Error("Overlay mount did not start");
    await setTimeout(25);
  }
  mounts.push(merged);
  for (const dir of input.localDirectories) {
    const native = join(state, "native", dir);
    await mkdir(native, { recursive: true });
    const target = join(merged, dir);
    await mkdir(target, { recursive: true });
    run("mount", ["--bind", native, target]);
    mounts.push(target);
  }
  const started = performance.now();
  const command = spawn("bash", ["-lc", input.command], { cwd: merged, stdio: "inherit" });
  userCommandSpawned = command.pid !== undefined;
  const exitCode = await new Promise((resolve, reject) => {
    command.once("error", reject);
    command.once("exit", (code, signal) =>
      signal ? reject(new Error(`Command killed by ${signal}`)) : resolve(code),
    );
  });
  const commandMs = performance.now() - started;

  // Inspect ONLY the upper. Never walk the composed tree or dependency directories.
  const writes = [];
  const removed = new Set();
  async function walk(dir, relative = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (input.localDirectories.some((local) => path === local || path.startsWith(`${local}/`)))
        continue;
      if (entry.name.startsWith(".wh.")) continue;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), path);
        continue;
      }
      const stat = await lstat(join(dir, entry.name));
      if (stat.isCharacterDevice() && stat.rdev === 0) continue;
      if (!entry.isFile())
        throw new Error(`Prototype cannot persist a special file or symlink: ${path}`);
      if ((stat.mode & 0o111) !== (original.get(path)?.mode === "100755" ? 0o111 : 0)) {
        throw new Error(`Prototype cannot persist executable-mode changes: ${path}`);
      }
      const bytes = await readFile(join(dir, entry.name));
      const version = `git:${createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")}`;
      if (version !== original.get(path)?.version) writes.push({ path, bytes });
    }
  }
  await walk(upper);
  // Overlay may represent deletes as whiteouts or opaque-directory xattrs. Check the
  // composed result for originals under affected roots instead of trusting either form.
  const changedRoots = new Set();
  let rootOpaque = false;
  for (const name of await readdir(upper)) {
    if (input.localDirectories.includes(name)) continue;
    if (name === ".wh..wh..opq") rootOpaque = true;
    else changedRoots.add(name.startsWith(".wh.") ? name.slice(4) : name);
  }
  for (const path of original.keys()) {
    if (!rootOpaque && !changedRoots.has(path.split("/")[0])) continue;
    try {
      if ((await lstat(join(merged, path))).isDirectory()) removed.add(path);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") removed.add(path);
      else throw error;
    }
  }
  for (const write of writes) removed.delete(write.path);
  for (const change of [...writes, ...[...removed].map((path) => ({ path, bytes: null }))]) {
    const result = await fetch(`${endpoint}/file?${new URLSearchParams({ path: change.path })}`, {
      method: change.bytes === null ? "DELETE" : "PUT",
      body: change.bytes,
    });
    if (!result.ok)
      throw new Error(
        `Workspace write ${change.path}: HTTP ${result.status}: ${await result.text()}`,
      );
  }
  synchronized = true;
  console.info(
    JSON.stringify({
      prototype: { commandMs, changedFiles: writes.length, deletedFiles: removed.size },
    }),
  );
  process.exitCode = exitCode;
} catch (error) {
  commandError = error;
} finally {
  for (const mount of mounts.reverse()) {
    try {
      await unmount(mount);
    } catch (error) {
      cleanupError ??= error;
    }
    if (mount === merged) {
      try {
        await stopOverlay();
      } catch (error) {
        cleanupError ??= error;
      }
    }
  }
  try {
    await stopOverlay();
  } catch (error) {
    cleanupError ??= error;
  }
  try {
    await stopDaemon();
  } catch (error) {
    cleanupError ??= error;
  }
  if (!cleanupError && temp) {
    try {
      await rm(temp, { recursive: true });
    } catch (error) {
      cleanupError = error;
    }
  }
  if (!cleanupError && pendingOwned && (synchronized || !userCommandSpawned)) {
    try {
      await rm(pending, { recursive: true });
    } catch (error) {
      cleanupError = error;
    }
  }
  if (pendingOwned && (cleanupError || (userCommandSpawned && !synchronized))) {
    try {
      await writeFile(
        join(pending, "failure.json"),
        JSON.stringify({
          commandSpawned: userCommandSpawned,
          synchronized,
          commandError: commandError?.message,
          cleanupError: cleanupError?.message,
        }),
      );
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (cleanupError || (userCommandSpawned && !synchronized))
    console.error(`Unsynchronized changes and their original manifest remain in ${pending}`);
}
if (commandError && cleanupError)
  throw new AggregateError([commandError, cleanupError], "Command and mount cleanup failed");
if (commandError) throw commandError;
if (cleanupError) throw cleanupError;

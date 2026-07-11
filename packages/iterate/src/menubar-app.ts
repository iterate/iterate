// ─────────────────────────────────────────────────────────────────────────────
// `iterate approve --menubar` — build (on first use) and launch the menu-bar
// approver app.
//
// The published package ships only the Swift SOURCE (packages/iterate/menubar);
// this compiles it with swiftc on the user's Mac, cached by source hash next to
// the config, and launches the .app — the same compile-on-first-use pattern as
// the enclave signer. It also writes ~/.config/iterate/menubar.json so the app
// knows which CLI to spawn (this exact one) for which project.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { run } from "./run-command.ts";

const CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : join(homedir(), ".config"),
  "iterate",
);
const BUILD_DIR = join(CONFIG_DIR, "menubar-build");
const APP_PATH = join(BUILD_DIR, "Iterate.app");
const SOURCES = [
  "Iterate.swift",
  "IterateIcon.swift",
  "build-menubar-app.sh",
  "Iterate.entitlements",
];

/** Compile-if-needed and launch the menu-bar app for one project/config. */
export async function launchMenubarApp(input: {
  configName: string;
  project: string;
  log?: (message: string) => void;
}): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("The menu-bar app is macOS-only.");
  }
  const log = input.log ?? (() => {});
  const menubarDir = join(import.meta.dirname, "..", "menubar");
  const binPath = join(import.meta.dirname, "..", "bin", "iterate.js");

  // Cache by source hash: rebuild only when the Swift (or build script) changed.
  const contents = await Promise.all(
    SOURCES.map((name) => readFile(join(menubarDir, name), "utf8")),
  );
  const hash = createHash("sha256").update(contents.join("\0")).digest("hex").slice(0, 12);
  const marker = join(BUILD_DIR, `.built-${hash}`);
  if (!existsSync(marker) || !existsSync(APP_PATH)) {
    log("Building the menu-bar app (swiftc)…");
    await mkdir(BUILD_DIR, { recursive: true });
    const build = await run("bash", [join(menubarDir, "build-menubar-app.sh"), BUILD_DIR]);
    if (build.exitCode !== 0) {
      throw new Error(
        `Menu-bar build failed — install the Xcode command-line tools (xcode-select --install)?\n${
          build.stderr.trim() || build.stdout.trim()
        }`,
      );
    }
    await writeFile(marker, hash);
  }

  // Point the app at THIS CLI (whatever launched us) for this project/config.
  // Auth is the app's own concern — its Sign in button runs `iterate login`.
  await writeFile(
    join(CONFIG_DIR, "menubar.json"),
    `${JSON.stringify(
      {
        command: process.execPath,
        args: [binPath],
        config: input.configName,
        project: input.project,
      },
      null,
      2,
    )}\n`,
  );

  const open = await run("open", [APP_PATH]);
  if (open.exitCode !== 0) throw new Error(`Could not launch the app: ${open.stderr.trim()}`);
  log(`Launched Iterate for project "${input.project}" (config ${input.configName}).`);
  log("It lives in your menu bar — click the 𝑖 to sign in and approve requests.");
}

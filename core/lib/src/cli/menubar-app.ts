// ─────────────────────────────────────────────────────────────────────────────
// `iterate menubar` — build (on first use) and launch the menu-bar
// app.
//
// The published package ships only the Swift SOURCE (core/lib/menubar);
// this compiles it with swiftc on the user's Mac, cached by source hash next to
// the config, and launches the .app. It also writes ~/.config/iterate/menubar.json
// so the app knows which CLI to spawn (this exact one) for which project.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CONFIG_DIR } from "./config.ts";
import { run } from "./run-command.ts";

const BUILD_DIR = join(CONFIG_DIR, "menubar-build");
const APP_PATH = join(BUILD_DIR, "Iterate.app");
const SOURCES = ["Iterate.swift", "IterateIcon.swift", "build-menubar-app.sh"];

/** Compile-if-needed and launch the menu-bar app for one project/config. */
export async function launchMenubarApp(input: {
  configName: string;
  project: string;
  log?: (message: string) => void;
}): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("The menu-bar app is macOS-only.");
  }
  const log = input.log || (() => {});
  const root = packageRoot();
  const menubarDir = join(root, "menubar");
  const binPath = join(root, "bin", "iterate.js");

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
        xdgConfigHome: process.env.XDG_CONFIG_HOME,
      },
      null,
      2,
    )}\n`,
  );

  const open = await run("open", ["-a", APP_PATH, join(CONFIG_DIR, "menubar.json")]);
  if (open.exitCode !== 0) throw new Error(`Could not launch the app: ${open.stderr.trim()}`);
  log(`Launched Iterate for project "${input.project}" (config ${input.configName}).`);
  log(
    "It lives in your menu bar — click the 𝑖 to sign in and " +
      "share your computer with the project's agents.",
  );
}

/** The `iterate` package's root, the folder holding `bin/iterate.js`: this module runs from
 *  `src/cli/` in the repo and from a `dist/` chunk once built. */
function packageRoot() {
  for (let dir = import.meta.dirname; dir !== dirname(dir); dir = dirname(dir))
    if (existsSync(join(dir, "bin", "iterate.js"))) return dir;
  throw new Error(`no bin/iterate.js above ${import.meta.dirname}`);
}

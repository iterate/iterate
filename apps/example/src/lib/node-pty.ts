import { createRequire } from "node:module";
import { homedir } from "node:os";
import type { PtyProcess } from "./pty.ts";

const require = createRequire(import.meta.url);

let nodePtyModule: typeof import("@lydell/node-pty") | undefined;

function getNodePtyModule(): typeof import("@lydell/node-pty") {
  nodePtyModule ??= require("@lydell/node-pty") as typeof import("@lydell/node-pty");
  return nodePtyModule;
}

/**
 * Node-only PTY runtime backed by a real PTY process.
 */
export function spawnNodePtyProcess(): PtyProcess {
  return spawnPtyProcess();
}

function createDefaultPtySpawnOptions() {
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  } as Record<string, string>;

  if (env.FORCE_COLOR && env.NO_COLOR) {
    delete env.NO_COLOR;
  }

  return {
    command: process.env.SHELL || "/bin/bash",
    args: [],
    cwd: homedir(),
    env,
    cols: 80,
    rows: 24,
    name: "xterm-256color",
  };
}

function spawnPtyProcess(): PtyProcess {
  const options = createDefaultPtySpawnOptions();
  return getNodePtyModule().spawn(options.command, options.args, {
    name: options.name,
    cwd: options.cwd,
    env: options.env,
    cols: options.cols,
    rows: options.rows,
  });
}

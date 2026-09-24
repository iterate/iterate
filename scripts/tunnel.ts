// `pnpm tunnel 3000 --name jonas` opens https://jonas.tunnels.iterate.com.
// Captun's CLI reads its config, not CAPTUN_TOKEN. Give this process an isolated config so the
// shared token never appears in argv and the developer's personal Captun settings stay intact.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tunnelsEnvs } from "../envs.ts";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const gateway = `https://${tunnelsEnvs.prd.hostname}`;
const help = args.includes("--help") || args.includes("-h");
let token = process.env.CAPTUN_TOKEN?.trim();
if (!help && !token) {
  const result = spawnSync(
    "doppler",
    ["secrets", "get", "CAPTUN_TOKEN", "--project", "_shared", "--config", "preview", "--plain"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Could not read CAPTUN_TOKEN from _shared/preview.");
  token = result.stdout.trim();
  if (!token) throw new Error("CAPTUN_TOKEN is empty in _shared/preview.");
}

const configHome = mkdtempSync(path.join(tmpdir(), "iterate-captun-"));
try {
  mkdirSync(path.join(configHome, "captun"), { mode: 0o700 });
  writeFileSync(
    path.join(configHome, "captun", "config.json"),
    JSON.stringify({ gateway, token }),
    {
      mode: 0o600,
    },
  );
  const child = spawn(
    "pnpm",
    [
      "--dir",
      fileURLToPath(new URL("../apps/tunnels", import.meta.url)),
      "exec",
      "captun",
      ...args,
    ],
    { stdio: "inherit", env: { ...process.env, XDG_CONFIG_HOME: configHome } },
  );
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 1)));
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
} finally {
  rmSync(configHome, { recursive: true, force: true });
}

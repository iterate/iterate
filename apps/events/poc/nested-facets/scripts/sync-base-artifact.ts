#!/usr/bin/env npx tsx
// Sync a local folder into the base-template artifact repo.
//
// Usage:
//   CLOUDFLARE_ACCOUNT_ID=cc7f6f461fbe823c199da2b27f9e0ff3 npx tsx scripts/sync-base-artifact.ts ./base-template
//
// The folder should contain config.json and apps/<name>/index.js (or TS+React apps with package.json).
// Everything in the folder is committed and force-pushed to the base-template artifact repo.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? "cc7f6f461fbe823c199da2b27f9e0ff3";
const TOKEN_FILE = `${process.env.HOME}/Library/Preferences/.wrangler/config/default.toml`;
const tokenLine = fs
  .readFileSync(TOKEN_FILE, "utf8")
  .split("\n")
  .find((l) => l.startsWith("oauth_token"));
const API_TOKEN = tokenLine!.split('"')[1];
const NAMESPACE = "default";
const BASE_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/artifacts/namespaces/${NAMESPACE}`;

async function api(method: string, apiPath: string, body?: object) {
  const resp = await fetch(`${BASE_URL}${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return resp.json() as any;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

function copyDirSync(src: string, dest: string) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function main() {
  const sourceDir = process.argv[2];
  if (!sourceDir) {
    console.error("Usage: npx tsx scripts/sync-base-artifact.ts <local-folder>");
    console.error("Example: npx tsx scripts/sync-base-artifact.ts ./base-template");
    process.exit(1);
  }

  const resolvedSource = path.resolve(sourceDir);
  if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isDirectory()) {
    console.error(`Not a directory: ${resolvedSource}`);
    process.exit(1);
  }

  // 1. Get or create base-template repo
  console.log("Getting base-template repo...");
  let result = await api("POST", "/repos", { name: "base-template" });
  if (!result.success) {
    result = await api("GET", "/repos/base-template");
    if (!result.success)
      throw new Error("Failed to get base-template repo: " + JSON.stringify(result));
    result = result.result;
  }

  const remote = result.remote ?? result.result?.remote;
  let token = result.token ?? result.result?.token;
  if (!token) {
    const tokenResult = await api("POST", "/tokens", {
      repo: "base-template",
      scope: "write",
      ttl: 3600,
    });
    token = tokenResult.result?.plaintext;
  }
  console.log("Remote:", remote);

  // 2. Create fresh git repo (no history — avoids SQLITE_TOOBIG from old large blobs)
  const tmpDir = `/tmp/base-template-sync-${Date.now()}`;
  const tokenSecret = token.split("?expires=")[0];
  const authRemote = remote.replace("https://", `https://x:${tokenSecret}@`);

  fs.mkdirSync(tmpDir, { recursive: true });
  execSync(`git init && git checkout -b main`, { cwd: tmpDir, stdio: "pipe" });
  execSync(`git remote add origin "${authRemote}"`, { cwd: tmpDir, stdio: "pipe" });
  console.log("Fresh repo at", tmpDir);

  // 4. Copy source folder contents into the repo
  copyDirSync(resolvedSource, tmpDir);
  console.log(`Copied ${resolvedSource} → ${tmpDir}`);

  // 5. Commit and push
  execSync(`cd "${tmpDir}" && git add -A`, { stdio: "pipe" });

  // Check if there are changes
  const status = execSync(`cd "${tmpDir}" && git status --porcelain`, { encoding: "utf8" }).trim();
  if (!status) {
    console.log("No changes to push — base-template is already up to date.");
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  console.log("Changes:\n" + status);
  execSync(`cd "${tmpDir}" && git commit -m "Sync from ${path.basename(resolvedSource)}"`, {
    stdio: "pipe",
  });
  execSync(`cd "${tmpDir}" && git push origin main --force`, { stdio: "inherit" });

  console.log("\nBase template synced successfully!");

  // 6. Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main();

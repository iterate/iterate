// Publishes the mobile app's JS bundle to the EAS Update `preview` channel;
// installed preview builds pull it on next launch. Then makes sure a native
// preview build exists for the update's runtime version: the fingerprint
// changes when native modules/config change, and old binaries silently
// ignore incompatible updates, so on mismatch this kicks off a fresh EAS
// build (--no-wait) whose install link supersedes the stale one.
// Runs on merge to main (.depot/workflows/mobile-eas-update.yml) with
// EXPO_TOKEN supplied by Doppler (`_shared`, inherited into os/prd).
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const mobileDir = path.join(repoRoot, "apps/mobile");

if (!process.env.EXPO_TOKEN) {
  throw new Error("EXPO_TOKEN is not set — eas-cli cannot authenticate");
}

const run = (command: string, args: string[], cwd: string) =>
  execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const eas = (args: string[]) =>
  run("pnpm", ["dlx", "eas-cli@21.0.1", ...args, "--non-interactive"], mobileDir);

// pnpm dlx prefixes install noise and eas-cli appends upgrade notices, so
// slice out the JSON payload rather than parsing the whole stream.
const easJson = (args: string[]) => {
  const output = eas([...args, "--json"]);
  const start = output.search(/[[{]/);
  const end = Math.max(output.lastIndexOf("]"), output.lastIndexOf("}"));
  if (start === -1 || end < start) {
    throw new Error(`no JSON found in eas output:\n${output}`);
  }
  return JSON.parse(output.slice(start, end + 1));
};

run("node", ["scripts/write-build-info.mjs"], mobileDir);

const message = run("git", ["log", "-1", "--format=%s"], repoRoot).trim().slice(0, 1024);
const published = easJson([
  "update",
  "--channel",
  "preview",
  "--platform",
  "ios",
  "--message",
  message,
]);
const updates = Array.isArray(published) ? published : [published];
const runtimeVersion = updates[0]?.runtimeVersion;
if (!runtimeVersion) {
  throw new Error(`unexpected eas update output: ${JSON.stringify(published)}`);
}
console.log(`published update ${updates[0].id} (runtime ${runtimeVersion}): ${message}`);

const builds: any[] = easJson(["build:list", "--platform", "ios", "--limit", "30"]);
const usable = ["NEW", "IN_QUEUE", "IN_PROGRESS", "FINISHED"];
const compatible = builds.find(
  (b) =>
    b.buildProfile === "preview" &&
    b.runtimeVersion === runtimeVersion &&
    usable.includes(b.status),
);
if (compatible) {
  console.log(`native preview build already exists: ${compatible.id} (${compatible.status})`);
} else {
  console.log(`no preview build for runtime ${runtimeVersion} — triggering a native build`);
  console.log(eas(["build", "--platform", "ios", "--profile", "preview", "--no-wait"]));
}

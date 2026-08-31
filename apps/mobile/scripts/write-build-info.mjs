// Stamps src/build-info.json with where the JS bundle came from, so the
// in-app Build info screen can show it. Runs before every `eas update`
// publish (CI: scripts/ci/publish-mobile-update.ts) and on EAS build
// machines via the eas-build-pre-install hook. The checked-in file is an
// all-empty placeholder: empty strings mean an unstamped local Metro bundle.
// CI/EAS checkouts are ephemeral, so the stamp never lands in git; the one
// local caller (`pnpm update:preview`) restores the placeholder afterwards.
//
// Beyond provenance, the stamp also carries the bundle's EXPECTATION —
// which backend this JS was published to talk to (expectedBackendEnv, an
// envs.ts config key like "preview_3") and a per-PR test identity
// (testLoginEmail). The PR publisher supplies them via env vars; every
// other caller (main publishes, EAS build machines, local) stamps "",
// meaning "no recommendation" — phones default to prd.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("../src/build-info.json", import.meta.url));

// EAS machines: when the uploaded project archive already carries a stamp
// (CI stamps before triggering `eas build`, and eas-cli uploads the working
// tree including that uncommitted change), keep it — it knows the PR branch
// and expected backend, which this .git-less machine cannot reconstruct.
// Only unstamped archives (local `eas build` runs) fall through to stamping.
if (process.env.EAS_BUILD) {
  const existing = JSON.parse(readFileSync(out, "utf8"));
  if (existing.builtAt) {
    console.log(`keeping existing stamp in ${out}: ${JSON.stringify(existing)}`);
    process.exit(0);
  }
}

const git = (args) => {
  try {
    return execSync(`git ${args}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // EAS build machines get a .git-less archive; env vars cover it below.
    return "";
  }
};

const env = process.env;
const info = {
  commit: env.EAS_BUILD_GIT_COMMIT_HASH || git("rev-parse HEAD"),
  // No EAS env var carries the message, so EAS's .git-less archive stamps "".
  message: git("log -1 --format=%s").slice(0, 200),
  // GITHUB_HEAD_REF is the PR head branch (pull_request runs); GITHUB_REF_NAME
  // is "<n>/merge" there, so it only wins on push runs where it's the real branch.
  branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || git("rev-parse --abbrev-ref HEAD"),
  builtBy: env.EAS_BUILD_USERNAME || env.GITHUB_ACTOR || userInfo().username,
  machine: env.EAS_BUILD ? "eas-build" : env.CI ? "ci" : hostname(),
  builtAt: new Date().toISOString(),
  expectedBackendEnv: env.MOBILE_EXPECTED_BACKEND_ENV || "",
  testLoginEmail: env.MOBILE_TEST_LOGIN_EMAIL || "",
  // The runtime fingerprint the publisher computed for this working tree —
  // the bundle's own record of which native build it expects. CI supplies it
  // (scripts/ci/mobile-preview.ts computeRuntimeFingerprint) and asserts the
  // published runtime agreed; local/EAS stamps "" (unknown).
  runtimeFingerprint: env.MOBILE_RUNTIME_FINGERPRINT || "",
};

writeFileSync(out, `${JSON.stringify(info, null, 2)}\n`);
console.log(`stamped ${out}: ${JSON.stringify(info)}`);

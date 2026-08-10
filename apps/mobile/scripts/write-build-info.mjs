// Stamps src/build-info.json with where the JS bundle came from, so the
// in-app Build info screen can show it. Runs before every `eas update`
// publish (CI: scripts/ci/publish-mobile-update.ts) and on EAS build
// machines via the eas-build-pre-install hook. The checked-in file is an
// all-empty placeholder: empty strings mean an unstamped local Metro bundle.
// CI/EAS checkouts are ephemeral, so the stamp never lands in git; the one
// local caller (`pnpm update:preview`) restores the placeholder afterwards.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { fileURLToPath } from "node:url";

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
  // Where to file a bug against this exact bundle: the PR for PR-channel
  // publishes, the commit page for main-channel publishes (set by the CI
  // publish scripts). Empty = local/EAS-machine stamp; the drawer's
  // "Report bug" item hides itself.
  githubUrl: env.MOBILE_BUILD_GITHUB_URL || "",
};

const out = fileURLToPath(new URL("../src/build-info.json", import.meta.url));
writeFileSync(out, `${JSON.stringify(info, null, 2)}\n`);
console.log(`stamped ${out}: ${JSON.stringify(info)}`);

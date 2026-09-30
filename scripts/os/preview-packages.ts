// scripts/os/preview-packages.ts — A PREVIEW'S PACKAGES, SERVED BEFORE ANYTHING INSTALLS THEM. Every
// project a preview seeds installs this repository's packages at the deployment's packages commit
// (apps/os/scripts/published-package-commit.ts says which) through esm.sh. The push that starts
// the preview deploy starts .github/workflows/pkg-pr-new.yml too, and pkg.pr.new serves the build
// only once that run has published it, so the deploy (scripts/os/preview.ts) waits for it here
// before it hands the deployment on.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pkgPrNewVersion } from "iterate/pkg-pr-new";
import {
  fetchRetryingPlatformFailures,
  httpFailureFields,
  httpFailureKind,
  isPlatformFailureKind,
  UPSTREAM_ONCE,
} from "iterate/platform-retry";
import { z } from "zod";

/** The names of the packages pkg-pr-new.yml's `pkg-pr-new publish` step publishes, each its
 *  directory's package.json `name`: one invocation publishes them all, so pkg.pr.new serves them
 *  together. */
export function publishedPackagesOf(repoRoot: string): string[] {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/pkg-pr-new.yml"), "utf8");
  const publish = /^\s+- run: pnpm exec pkg-pr-new publish (.+)$/m.exec(workflow);
  if (!publish) throw new Error("pkg-pr-new.yml has no `pnpm exec pkg-pr-new publish` step");
  return [...publish[1]!.matchAll(/(?:^|\s)\.\/(\S+)/g)].map(
    (directory) =>
      z
        .object({ name: z.string() })
        .parse(JSON.parse(readFileSync(path.join(repoRoot, directory[1]!, "package.json"), "utf8")))
        .name,
  );
}

/** How often the wait asks pkg.pr.new, and how long it waits at most. pkg-pr-new.yml's run takes
 *  about a minute, and has taken four (2026-09-30). */
export const AWAIT_PUBLISHED = { pollMs: 5_000, boundMs: 10 * 60_000 };

/**
 * WAIT UNTIL pkg.pr.new SERVES every one of `packages` at `commit`: a HEAD of each
 * `https://pkg.pr.new/iterate/iterate/<package>@<commit>` every AWAIT_PUBLISHED.pollMs, asking
 * only for those not yet served, until each answers 200. A 404 is pkg.pr.new not serving it yet.
 * It asks pkg.pr.new and never esm.sh, through which the platform installs a project's pkg.pr.new
 * dependencies (apps/os/src/context/module-resolution.ts): esm.sh answers "tarball … not found"
 * for a build asked for before pkg.pr.new serves it, and goes on answering that for a while after.
 *
 * Bounded and observable: one line per change of what pkg.pr.new answers, and one when it serves
 * them all; past AWAIT_PUBLISHED.boundMs it throws, naming each package still unserved and its
 * last answer. A HEAD pkg.pr.new fails on its own side counts as not served this round: a 5xx or a
 * dropped connection once it has been sent again a second later (UPSTREAM_ONCE), a 429 or no answer
 * in 10 s at once. Any other answer is about the request, which asking again does not change: it
 * throws at once.
 */
export async function awaitPublishedPackages(input: {
  commit: string;
  packages: string[];
  fetchFn: typeof fetch;
  log: (line: string) => void;
}) {
  const { commit, packages } = input;
  const started = Date.now();
  const waited = () => `${Math.round((Date.now() - started) / 1000)} s`;
  let unserved = packages;
  let reported = "";
  for (;;) {
    const answers = await Promise.all(
      unserved.map(async (name) => ({
        name,
        answer: await pkgPrNewAnswer(pkgPrNewVersion(name, commit), input.fetchFn),
      })),
    );
    const missing = answers.filter(({ answer }) => answer !== 200);
    unserved = missing.map(({ name }) => name);
    if (missing.length === 0) {
      input.log(`[pkg.pr.new] ${waited()}: serves ${packages.join(", ")} at ${commit}`);
      return;
    }
    const state = missing.map(({ name, answer }) => `${name} ${answer}`).join(", ");
    if (state !== reported) input.log(`[pkg.pr.new] ${waited()}: at ${commit}, ${state}`);
    reported = state;
    if (Date.now() - started >= AWAIT_PUBLISHED.boundMs)
      throw new Error(
        `pkg.pr.new did not serve ${unserved.join(", ")} at ${commit} within ${AWAIT_PUBLISHED.boundMs / 60_000} minutes; pkg-pr-new.yml's run for the commit publishes them (https://github.com/iterate/iterate/actions/workflows/pkg-pr-new.yml). The last answers:\n${missing.map(({ name, answer }) => `  ${pkgPrNewVersion(name, commit)} ${answer}`).join("\n")}`,
      );
    await new Promise((resolve) => setTimeout(resolve, AWAIT_PUBLISHED.pollMs));
  }
}

/** pkg.pr.new's answer to a HEAD of `version` (`awaitPublishedPackages` says how each is read):
 *  200, 404, the status of a failure of pkg.pr.new's that stood, or when no answer came, why. */
async function pkgPrNewAnswer(version: string, fetchFn: typeof fetch) {
  let answer: Response;
  try {
    answer = await fetchRetryingPlatformFailures(
      `HEAD ${version}`,
      (signal) => fetchFn(version, { method: "HEAD", signal }),
      { area: "pkg-pr-new", idempotent: true, schedule: UPSTREAM_ONCE, timeoutMs: 10_000 },
    );
  } catch (error) {
    if (!isPlatformFailureKind(httpFailureKind(error))) throw error;
    const { status, message } = httpFailureFields(error);
    return status === "network" ? message : status;
  }
  if (answer.status === 200 || answer.status === 404) return answer.status;
  throw new Error(`HEAD ${version} answered ${answer.status}, which asking again does not change`);
}

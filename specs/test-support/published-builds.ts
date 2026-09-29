import {
  pinPkgPrNewVersion,
  pkgPrNewVersion,
  pkgPrNewVersionOf,
} from "@iterate-com/shared/pkg-pr-new";
import { z } from "zod";

/**
 * A commit on main before the one its newest builds are at, whose builds of every package in
 * `packages` pkg.pr.new serves: the nearest of the newest's first five ancestors (GitHub's list of
 * main's commits, with the run's token when it has one; every main commit publishes every package).
 * A spec seeds a project at it to upgrade from an older build to the newest.
 */
export async function olderMainCommit(packages: [string, ...string[]]) {
  const [name] = packages;
  const pinned = await pinPkgPrNewVersion(name, pkgPrNewVersion(name, "main"));
  // pinPkgPrNewVersion answers a pkg.pr.new version of `name` at a commit, or throws
  const newest = pkgPrNewVersionOf(name, pinned)!.ref;
  const token = process.env.GITHUB_TOKEN?.trim();
  const answer = await fetch(
    `https://api.github.com/repos/iterate/iterate/commits?sha=${newest}&per_page=6`,
    {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!answer.ok)
    throw new Error(`GitHub answered ${answer.status} for main's commits before ${newest}`);
  const commits = z.array(z.object({ sha: z.string() })).parse(await answer.json());
  for (const { sha } of commits.slice(1)) {
    const served = await Promise.all(
      packages.map((pkg) =>
        fetch(pkgPrNewVersion(pkg, sha), { method: "HEAD", signal: AbortSignal.timeout(10_000) }),
      ),
    );
    if (served.every((build) => build.ok)) return sha;
  }
  throw new Error(
    `pkg.pr.new serves ${packages.join(" and ")} at none of the commits before ${newest}`,
  );
}

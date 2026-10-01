// pkg-pr-new.ts — pkg.pr.new builds as a config repo's package.json lists them
// (`https://pkg.pr.new/<owner>/<repo>/<package>@<ref>`), and how everything that writes one pins it.
// The platform's loader loads such a dependency only at a full commit and refuses a branch or a PR
// number (core/os/src/context/module-resolution.ts says why), so a writer resolves a moving ref
// once, as it writes, the way npm's lockfile holds a git dependency at its commit
// (https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json#packages). The writers: the
// platform's seed of a config repo from a template (core/os/src/project/processor.ts), the apps
// that upgrade agents and voice to main's newest build (`buildStanding`), and the e2e rows.
import { z } from "zod";
import { fetchRetryingPlatformFailures, UPSTREAM_ONCE } from "./platform-retry.ts";

/** A pkg.pr.new build as its URL names it, in parts, or undefined for any other version and for a
 *  pkg.pr.new URL of another shape. A package.json may list it under another name: an alias, as npm
 *  installs a tarball URL under the name it is listed by. */
export function pkgPrNewBuildOf(version: string) {
  if (!version.startsWith("https://pkg.pr.new/")) return undefined;
  const [owner, repo, ...rest] = new URL(version).pathname.slice(1).split("/");
  const listed = rest.join("/");
  // the `@` before the ref, after a scope's own
  const at = listed.indexOf("@", 1);
  if (!owner || !repo || at < 0 || at === listed.length - 1) return undefined;
  return { owner, repo, name: listed.slice(0, at), ref: listed.slice(at + 1) };
}

/** A pkg.pr.new version of package `name`, in parts, or undefined for any other version: an npm
 *  range, an exact version or a dist-tag, and a pkg.pr.new URL of another shape or package. */
export function pkgPrNewVersionOf(name: string, version: string) {
  const build = pkgPrNewBuildOf(version);
  return build?.name === name ? build : undefined;
}

/** Whether a pkg.pr.new ref names one build: all 40 hex digits of a commit. A branch or a PR number
 *  names whatever was published for it last. A short sha is refused too: it reads like a branch
 *  name, and pkg.pr.new's `x-commit-key` echoes it rather than naming the commit. */
export const isPkgPrNewCommit = (ref: string) => /^[0-9a-f]{40}$/.test(ref);

/** A build of one of this repository's packages (`iterate`, `@iterate-com/voice`, …): the
 *  pkg.pr.new workflow (.github/workflows/pkg-pr-new.yml) publishes every package together, for
 *  every main commit and for the head of a PR that changes one. */
export const pkgPrNewVersion = (name: string, ref: string) =>
  `https://pkg.pr.new/iterate/iterate/${name}@${ref}`;

/**
 * `version` of package `name` as a writer writes it: a pkg.pr.new branch or PR at the commit
 * pkg.pr.new serves for it now, and any other version as it is. The commit is the HEAD's
 * `x-commit-key` (`<owner>:<repo>:<commit>`), trusted only as 40 hex digits: a 404 echoes there the
 * ref it was asked for. The HEAD is sent once more a second later when pkg.pr.new fails it
 * (UPSTREAM_ONCE), each attempt within 10 s. A ref it cannot pin throws, so nothing is written with
 * a ref that moves.
 */
export async function pinPkgPrNewVersion(
  name: string,
  version: string,
  fetchFn: typeof fetch = globalThis.fetch,
) {
  const parts = pkgPrNewVersionOf(name, version);
  if (!parts || isPkgPrNewCommit(parts.ref)) return version;
  const served = await servedBuild(version, fetchFn);
  if (!served.commit)
    throw new Error(
      `${version} answered ${served.status} without naming the commit it serves, so it cannot be pinned`,
    );
  return `https://pkg.pr.new/${parts.owner}/${parts.repo}/${name}@${served.commit}`;
}

/** Where a project's installed build of one of this repository's packages stands against the newest
 *  build main has published, by commit (`buildStanding`). */
export type BuildStanding =
  /** `installed`, the version as its package.json pins it, is not this repository's build at a
   *  commit (an npm version, a fork's build): the project's own, which it upgrades itself */
  | { kind: "own"; installed: string }
  /** the installed build is main's newest */
  | { kind: "newest"; installed: string }
  /** main published `newest` after `installed`, or pkg.pr.new no longer serves `installed`: an
   *  upgrade, to `version` (`newest` as package.json pins it) */
  | { kind: "behind"; installed: string; newest: string; version: string }
  /** `installed` was published after main's newest: a pull request's build */
  | { kind: "ahead"; installed: string; newest: string };

/**
 * WHETHER MAIN HAS A NEWER BUILD of package `name` than `installed`, the version a project's source
 * pins: main's newest is `…@main` at the commit pkg.pr.new serves for it now, and newer is later
 * published, by pkg.pr.new's `last-modified` (every main commit publishes a build, so a new commit
 * is a new build). The two HEADs go at once, each bounded as `pinPkgPrNewVersion` says. A build
 * answered without its commit or publish time throws, as does one pkg.pr.new keeps failing, so a
 * standing is never guessed. An app's Worker asks (a server function): a page cannot read these
 * headers.
 */
export async function buildStanding(
  name: string,
  installed: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<BuildStanding> {
  const commit = pkgPrNewVersionOf(name, installed)?.ref ?? "";
  if (!isPkgPrNewCommit(commit) || installed !== pkgPrNewVersion(name, commit))
    return { kind: "own", installed };
  const main = pkgPrNewVersion(name, "main");
  const [newest, current] = await Promise.all([
    servedBuild(main, fetchFn),
    servedBuild(installed, fetchFn),
  ]);
  if (!newest.commit || !newest.publishedAt)
    throw new Error(
      `${main} answered ${newest.status} without naming the commit it serves and when it was published`,
    );
  // a build pkg.pr.new answers 404 for is older than every one it serves
  if (current.status !== 404 && !current.publishedAt)
    throw new Error(`${installed} answered ${current.status} without saying when it was published`);
  if (newest.commit === commit) return { kind: "newest", installed: commit };
  if (current.publishedAt && current.publishedAt > newest.publishedAt)
    return { kind: "ahead", installed: commit, newest: newest.commit };
  return {
    kind: "behind",
    installed: commit,
    newest: newest.commit,
    version: pkgPrNewVersion(name, newest.commit),
  };
}

/**
 * A source's files with every package.json's pkg.pr.new `dependencies` pinned
 * (`pinPkgPrNewVersion`), one HEAD per distinct version: what the platform commits when it seeds a
 * config repo from a template, whose `…@main` means main's newest build. A manifest with nothing to
 * pin keeps its bytes; one that changes is written back as JSON with two-space indents, its keys in
 * their order. `devDependencies` stay as written: the loader never reads them, and the tooling that
 * does (`npm install` for `tsc`) locks them itself, so a template's types can follow main.
 */
export async function pinPkgPrNewDependencies(
  files: { path: string; content: string }[],
  fetchFn: typeof fetch = globalThis.fetch,
) {
  const pins = new Map<string, Promise<string>>();
  const pin = (name: string, version: string) => {
    const key = `${name} ${version}`;
    if (!pins.has(key)) pins.set(key, pinPkgPrNewVersion(name, version, fetchFn));
    return pins.get(key)!;
  };
  return Promise.all(
    files.map(async (file) => {
      if (file.path !== "package.json" && !file.path.endsWith("/package.json")) return file;
      let parsed: unknown;
      try {
        parsed = JSON.parse(file.content);
      } catch {
        // a broken manifest is the loader's to refuse, by name, once the seed is committed
        return file;
      }
      const manifest = z.record(z.string(), z.unknown()).safeParse(parsed);
      const dependencies = z.record(z.string(), z.string()).safeParse(manifest.data?.dependencies);
      if (!manifest.success || !dependencies.success) return file;
      const pinned = Object.fromEntries(
        await Promise.all(
          Object.entries(dependencies.data).map(async ([name, version]) => [
            name,
            await pin(name, version),
          ]),
        ),
      );
      if (Object.entries(pinned).every(([name, version]) => dependencies.data[name] === version))
        return file;
      const content = `${JSON.stringify({ ...manifest.data, dependencies: pinned }, null, 2)}\n`;
      return { ...file, content };
    }),
  );
}

/** What pkg.pr.new serves at `version`, from one HEAD (`headPkgPrNew`): the answer's status, the
 *  commit it names in `x-commit-key` (`<owner>:<repo>:<commit>`, trusted only as 40 hex digits of a
 *  200: a 404 echoes there the ref it was asked for), and when that build was published
 *  (`last-modified`, epoch milliseconds). */
async function servedBuild(version: string, fetchFn: typeof fetch) {
  const answer = await headPkgPrNew(version, fetchFn);
  const key = answer.headers.get("x-commit-key")?.split(":").at(-1) ?? "";
  const publishedAt = Date.parse(answer.headers.get("last-modified") ?? "");
  return {
    status: answer.status,
    commit: answer.ok && isPkgPrNewCommit(key) ? key : undefined,
    publishedAt: answer.ok && Number.isFinite(publishedAt) ? publishedAt : undefined,
  };
}

/** One HEAD of a pkg.pr.new version, bounded as `pinPkgPrNewVersion` says; a 404 is an answer. */
function headPkgPrNew(version: string, fetchFn: typeof fetch) {
  return fetchRetryingPlatformFailures(
    `HEAD ${version}`,
    (signal) => fetchFn(version, { method: "HEAD", signal }),
    { area: "pkg-pr-new", idempotent: true, schedule: UPSTREAM_ONCE, timeoutMs: 10_000 },
  );
}

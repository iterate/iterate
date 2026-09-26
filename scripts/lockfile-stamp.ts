// scripts/lockfile-stamp.ts — A PULL REQUEST THAT CHANGED pnpm-lock.yaml CANNOT MERGE ONTO A MAIN
// WHOSE LOCKFILE CHANGED SINCE ITS BASE. Git merges the lockfile line by line, so two changes to
// different lines merge cleanly even when the result is a lockfile pnpm rejects (one side drops a
// package the other still resolves against), and CI tested each pull request merged into the main
// of its last push, not the main it lands on.
//
// This writes the lockfile's sha256 to pnpm-lock.yaml.sha256: one line that every lockfile change
// changes, so two branches that both changed the lockfile conflict there. GitHub refuses to merge a
// conflicting pull request, whoever merges it, until it is rebased, `pnpm install` has rewritten
// the lockfile and this stamp, and CI has tested the result. Two identical lockfiles have identical
// stamps and merge.
//
// The root `prepare` runs it after every local `pnpm install`. Lint and Typecheck runs it and fails
// when it changed the stamp: a lockfile committed without its stamp would not conflict. It needs
// only node, since it runs inside `pnpm install`.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const hash = createHash("sha256").update(readFileSync("pnpm-lock.yaml")).digest("hex");
const stamp = `# pnpm-lock.yaml's sha256, which \`pnpm install\` writes (scripts/lockfile-stamp.ts says why).
# A conflict on the line below means main's lockfile changed too: on the rebased branch run
# \`pnpm install\` and \`node scripts/lockfile-stamp.ts\`, then commit both files.
${hash}
`;
const path = "pnpm-lock.yaml.sha256";
if (!existsSync(path) || readFileSync(path, "utf8") !== stamp) {
  writeFileSync(path, stamp);
  console.log(`${path} now stamps pnpm-lock.yaml ${hash.slice(0, 12)}: commit it`);
}

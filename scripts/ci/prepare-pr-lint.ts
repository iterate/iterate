import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { getOctokit, getRepo, readEventPayload } from "./github.ts";

const pr = readEventPayload().pull_request;
if (!pr?.base?.sha || !pr.head?.sha) throw new Error("PR lint requires base and head SHAs");
const output = process.env.GITHUB_ENV;
if (!output) throw new Error("GITHUB_ENV is required");
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (head !== pr.head.sha) throw new Error("PR lint must check out the event's head SHA");

const { data } = await getOctokit().repos.compareCommitsWithBasehead({
  ...getRepo(),
  basehead: `${pr.base.sha}...${pr.head.sha}`,
  per_page: 1,
  request: { timeout: 10_000 },
});
const base = data.merge_base_commit.sha;
if (!/^[a-f0-9]{40}$/.test(base)) throw new Error("GitHub did not return a valid merge base");
execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", base], {
  stdio: "inherit",
  timeout: 60_000,
});
appendFileSync(output, `ITERATE_LINT_PR_BASE=${base}\n`);
console.log(`Grandfathered rules will check PR changed lines since ${base}`);

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { lintHead, type Job, type LintIo } from "./run.ts";

// One lint of one head against a fake GitHub (the pull request, rules/ served from fixtures/rules, one
// changed file) and fake models, with a part failing in each case: what the other parts found is
// still published, and the Check Run says what did not run.

const REPO = "/repos/iterate/iterate";
const job: Job = {
  key: "ai-linter/v2:iterate/iterate#7@head1",
  connection: "c1",
  repository: "iterate/iterate",
  number: 7,
  headSha: "head1",
  baseSha: "base1",
};
const config = { rules: "rules", model: "openai/gpt-6-astra" };

// iterate-lint-disable-next-line comments/no-narrating-comments -- describes the fixture, whose comment is the narration under test
/** An added file with a narrating comment (Jev flags it) and a cast (Jev is unsure: the LLM decides). */
const SOURCE = [
  "export function read(raw: string) {",
  "  // We added this parse after the outage on 2026-09-20, when a payload was empty.",
  "  const parsed = JSON.parse(raw);",
  "  return parsed as { id: string };",
  "}",
  "",
].join("\n");

test("every part runs: the review and a neutral Check Run carry the findings of both engines", async () => {
  const github = fakeGithub({});
  const outcome = await lintHead(job, config, io({ github }).lintIo);
  expect(outcome).toMatchObject({ status: "linted", problems: [], byEngine: { jev: 1, llm: 2 } });
  expect(checkRunOf(github.posted)).toMatchObject({
    conclusion: "neutral",
    external_id: job.key,
    output: { title: "3 findings" },
  });
  expect(
    reviewOf(github.posted).comments.map((comment: { body: string }) => comment.body.split("]")[0]),
  ).toEqual([
    "**[comments/no-repeated-explanations",
    "**[comments/no-narrating-comments",
    "**[typescript/explain-type-cast",
  ]);
});

test("the LLM's call fails: Jev's findings are still reviewed, and the Check Run says what did not run", async () => {
  const github = fakeGithub({});
  const { lintIo, calls } = io({
    github,
    llm: () => {
      throw new Error("5007: No such model openai/no-such-model");
    },
  });
  const outcome = await lintHead(job, { ...config, model: "openai/no-such-model" }, lintIo);
  expect(outcome).toMatchObject({ status: "linted", byEngine: { jev: 1, llm: 0 } });
  // the LLM rules' call, and the call on the cast Jev was unsure of
  expect(calls).toMatchObject({ llm: 2 });
  const review = reviewOf(github.posted);
  expect(
    review.comments.map((comment: { path: string; line: number }) => [comment.path, comment.line]),
  ).toEqual([["src/read.ts", 2]]);
  expect(review.body).toMatch(
    /\*\*Incomplete\.\*\*\n- The LLM's call failed, so comments\/no-repeated-explanations did not run: 5007/,
  );
  const check = checkRunOf(github.posted);
  // delivered again, the head is linted again
  expect(check).toMatchObject({
    conclusion: "neutral",
    external_id: `${job.key}:incomplete`,
    output: { title: "1 finding; incomplete: the LLM failed, unsure units undecided" },
  });
  expect(check.output.summary).toMatch(
    /^\*\*Incomplete\.\*\*\n- The LLM's call failed, so comments\/no-repeated-explanations did not run: 5007: No such model/,
  );
  expect(check.output.summary).toMatch(
    /The LLM's call on the 1 units Jev left unsure failed, so they are undecided/,
  );
  expect(check.output.summary).toMatch(
    /- \*\*\[comments\/no-narrating-comments\]\*\* `src\/read.ts:2` \(Jev, p 0.90\)/,
  );
});

test("Jev refuses every request: the LLM's findings still post, and after 12 in a row the rest are not asked", async () => {
  // Twenty narrating comments, each its own unit.
  const source = Array.from(
    { length: 20 },
    (_, index) =>
      `// Unit ${index} was added after the outage.\nexport const v${index} = ${index};`,
  ).join("\n");
  const github = fakeGithub({ source });
  const { lintIo, calls } = io({
    github,
    jev: () => {
      throw new Error("2018: Invalid User Credentials");
    },
  });
  const outcome = await lintHead(job, config, lintIo);
  expect(outcome).toMatchObject({
    status: "linted",
    jev: {
      units: 20,
      judged: 0,
      failed: 20,
      notJudged: [
        expect.stringMatching(
          /^\d+ units Jev did not answer in 5 tries \(2018: Invalid User Credentials\)$/,
        ),
        expect.stringMatching(/^\d+ units not asked, after 12 in a row went unanswered$/),
      ],
    },
  });
  expect(calls.jev, "the rest were not asked").toBeLessThan(20 * 5);
  expect(checkRunOf(github.posted)).toMatchObject({
    output: { title: "1 finding; incomplete: Jev did not judge 20 units" },
  });
  expect(reviewOf(github.posted).comments).toHaveLength(1);
});

test("a changed file cannot be read: Jev and an LLM rule that selects skip it, the whole diff's findings post without suppressions", async () => {
  const unreadable = (method: string, path: string) =>
    method === "GET" && path === `${REPO}/contents/src/read.ts`
      ? { status: 502, body: "bad gateway" }
      : undefined;
  const excerpts = fakeGithub({ fail: unreadable });
  const skipped = io({ github: excerpts });
  const outcome = await lintHead(job, config, skipped.lintIo);
  expect(outcome).toMatchObject({ status: "linted", byEngine: { jev: 0, llm: 0 } });
  expect(skipped).toMatchObject({ calls: { llm: 0, jev: 0 } });
  const check = checkRunOf(excerpts.posted);
  expect(check).toMatchObject({
    output: { title: "No findings; incomplete: a file was not read" },
  });
  expect(check.output.summary).toMatch(
    /- src\/read.ts could not be read, so Jev did not judge it and the LLM did not read it: GitHub GET \/repos\/iterate\/iterate\/contents\/src\/read.ts\?ref=head1: 502 bad gateway/,
  );

  // A rule the LLM reads the whole diff for: the LLM reads the file's diff, and its findings post.
  const whole = fakeGithub({
    fail: unreadable,
    extraRules: { "rules/whole-diff.md": WHOLE_DIFF_RULE },
  });
  const read = io({ github: whole });
  const withWholeDiff = await lintHead(job, config, read.lintIo);
  expect(withWholeDiff).toMatchObject({ byEngine: { jev: 0, llm: 1 } });
  expect(read).toMatchObject({ calls: { llm: 1, jev: 0 } });
  expect(checkRunOf(whole.posted).output.summary).toMatch(
    /- src\/read.ts could not be read, so Jev did not judge it and its suppressions were not applied: /,
  );
});

test("GitHub lists a changed file without its name: the others are linted, and the Check Run says one was not", async () => {
  // 143 files listed over two pages, the second entry of page 2 without its filename and status
  const github = fakeGithub({
    alsoListed: Array.from({ length: 142 }, (_, index) =>
      index === 100
        ? {
            sha: "c88986395d0cf995a15705159d1ed16459a6ef00",
            additions: 21,
            deletions: 17,
            changes: 38,
          }
        : { filename: `data/${index}.json`, status: "modified" },
    ),
  });
  const outcome = await lintHead(job, config, io({ github }).lintIo);
  expect(outcome).toMatchObject({ status: "linted", findings: 3 });
  const check = checkRunOf(github.posted);
  expect(check).toMatchObject({
    output: { title: "3 findings; incomplete: a file was not read" },
  });
  expect(check.output.summary).toMatch(
    /- Not linted: 1 of the changed files GitHub listed came without a filename or status/,
  );
});

test("a file GitHub lists without its name counts toward the 1,000 files read", async () => {
  const github = fakeGithub({
    alsoListed: [
      { sha: "c88986395d0cf995a15705159d1ed16459a6ef00" },
      ...Array.from({ length: 998 }, (_, index) => ({
        filename: `data/${index}.json`,
        status: "modified",
      })),
      { filename: "src/listed-1001st.ts", status: "modified" },
    ],
  });
  await lintHead(job, config, io({ github }).lintIo);
  expect(checkRunOf(github.posted).output.summary).not.toMatch(/listed-1001st/);
});

test("an LLM rule that selects comments reads only the comments' excerpts, and a pull request with none asks the LLM nothing", async () => {
  const far = Array.from({ length: 40 }, (_, index) => `export const far${index} = ${index};`);
  const source = [
    "// We added this after the outage on 2026-09-20.",
    "export const near = 1;",
    ...far,
    "",
  ].join("\n");
  const inputs: unknown[] = [];
  const commented = io({
    github: fakeGithub({ source }),
    llm: (input) => {
      inputs.push(input);
      return llmAnswers(input);
    },
  });
  await lintHead(job, config, commented.lintIo);
  expect(commented.calls).toMatchObject({ llm: 1 });
  const task = JSON.stringify(inputs[0]);
  expect(task).toMatch(
    /### src\/read.ts\\nrules: comments\/no-repeated-explanations\\nshown: excerpts/,
  );
  expect(task).toMatch(/We added this after the outage/);
  // the window: 5 lines after the comment
  expect(task).toMatch(/far3 = 3/);
  expect(task).not.toMatch(/far4 = 4/);

  const bare = io({ github: fakeGithub({ source: far.join("\n") }) });
  const outcome = await lintHead(job, config, bare.lintIo);
  expect(bare.calls).toMatchObject({ llm: 0 });
  expect(outcome).toMatchObject({
    title: "No findings",
    usage: { llmCalls: 0, llmInputTokens: 0, llmOutputTokens: 0, jevInputTokens: 0 },
  });
});

test("a head linted again after an incomplete verdict posts its own review for what it found, and the same findings post none", async () => {
  const github = fakeGithub({});
  const failing = io({
    github,
    llm: () => {
      throw new Error("5007: No such model");
    },
  });
  await lintHead(job, config, failing.lintIo);
  await lintHead(job, config, io({ github }).lintIo);
  await lintHead(job, config, io({ github }).lintIo);
  const reviews = github.posted.filter((post) => post.path === `${REPO}/pulls/7/reviews`);
  // the incomplete verdict's review (Jev's one finding), then the complete one's (all three), once
  expect(reviews.map((review) => review.body.comments.length)).toEqual([1, 3]);
});

test("a complete lint after an incomplete one with the same findings posts its own review, which does not say incomplete", async () => {
  let unreadable = true;
  const github = fakeGithub({
    extraRules: {
      "rules/other.md": "---\nid: t/other\nseverity: warning\nfiles: ['**/*.none']\n---\nNone.\n",
    },
    fail: (_method, path) =>
      unreadable && path === `${REPO}/contents/rules/other.md`
        ? { status: 502, body: "bad gateway" }
        : undefined,
  });
  await lintHead(job, config, io({ github }).lintIo);
  unreadable = false;
  await lintHead(job, config, io({ github }).lintIo);
  const reviews = github.posted.filter((post) => post.path === `${REPO}/pulls/7/reviews`);
  expect(
    reviews.map((review) => [
      review.body.comments.length,
      review.body.body.includes("**Incomplete.**"),
    ]),
  ).toEqual([
    [3, true],
    [3, false],
  ]);
});

test("a lint run again after a restart reads the LLM's answers it already had, and pays for none twice", async () => {
  const remembered = new Map<string, unknown>();
  const first = io({ github: fakeGithub({}), remembered });
  await lintHead(job, config, first.lintIo);
  // the LLM rules' call, and the call on the cast Jev was unsure of
  expect(first.calls).toMatchObject({ llm: 2 });
  const github = fakeGithub({});
  const again = io({ github, remembered });
  const outcome = await lintHead(job, config, again.lintIo);
  expect(again.calls).toMatchObject({ llm: 0 });
  expect(outcome).toMatchObject({
    status: "linted",
    findings: 3,
    usage: { llmCalls: 0, llmInputTokens: 0, llmOutputTokens: 0, jevInputTokens: 1600 },
  });
  expect(checkRunOf(github.posted)).toMatchObject({ output: { title: "3 findings" } });
});

test("the review is refused: the Check Run is still posted and lists every finding with its message", async () => {
  const github = fakeGithub({
    fail: (method, path) =>
      method === "POST" && path === `${REPO}/pulls/7/reviews`
        ? { status: 500, body: "boom" }
        : undefined,
  });
  const outcome = await lintHead(job, config, io({ github }).lintIo);
  expect(outcome).toMatchObject({ status: "linted", review: null });
  const check = checkRunOf(github.posted);
  expect(check).toMatchObject({
    output: { title: "3 findings; incomplete: the review was not posted" },
  });
  expect(check.output.summary).toMatch(
    /The review was not posted, so its findings are only listed here: GitHub POST \/repos\/iterate\/iterate\/pulls\/7\/reviews: 500 boom/,
  );
  expect(check.output.summary).toMatch(/`src\/read.ts:2` \(the LLM\): Said elsewhere\./);
  expect(check.output.summary).toMatch(
    /`src\/read.ts:4` \(the LLM, on a candidate Jev left unsure \(p 0.80\)\): This type assertion/,
  );
});

test("the Check Run is refused: the outcome keeps the review, the findings and why", async () => {
  const github = fakeGithub({
    fail: (method, path) =>
      method === "POST" && path === `${REPO}/check-runs` ? { status: 403, body: "no" } : undefined,
  });
  const outcome = await lintHead(job, config, io({ github }).lintIo);
  expect(outcome).toMatchObject({
    status: "failed",
    error: `the Check Run was not posted: GitHub POST ${REPO}/check-runs: 403 no`,
    findings: 3,
    review: "https://github.com/iterate/iterate/pull/7#pullrequestreview-1",
  });
});

test("a rule that does not parse, or cannot be read, is listed and the other rules run", async () => {
  const github = fakeGithub({
    extraRules: { "rules/broken.md": "no frontmatter here", "rules/gone.md": "" },
    fail: (_method, path) =>
      path === `${REPO}/contents/rules/gone.md` ? { status: 502, body: "bad gateway" } : undefined,
  });
  const outcome = await lintHead(job, config, io({ github }).lintIo);
  expect(outcome).toMatchObject({ findings: 3 });
  const check = checkRunOf(github.posted);
  expect(check).toMatchObject({ output: { title: "3 findings; incomplete: a rule did not run" } });
  expect(check.output.summary).toMatch(/- A rule did not run: rules\/broken.md: no frontmatter/);
  expect(check.output.summary).toMatch(
    /- A rule did not run: GitHub GET \/repos\/iterate\/iterate\/contents\/rules\/gone.md\?ref=base1: 502 bad gateway/,
  );
});

test("another rules folder is read instead of rules/", async () => {
  const github = fakeGithub({ rulesFolder: "lint/rules" });
  const outcome = await lintHead(job, { ...config, rules: "lint/rules" }, io({ github }).lintIo);
  expect(outcome).toMatchObject({ status: "linted", problems: [], findings: 3 });
});

test("the lint fails before it has anything to publish: a Check Run says so, keyed apart from the head's", async () => {
  const github = fakeGithub({
    fail: (_method, path) =>
      path === `${REPO}/contents/rules` ? { status: 404, body: "Not Found" } : undefined,
  });
  const outcome = await lintHead(job, config, io({ github }).lintIo);
  expect(outcome).toMatchObject({
    status: "failed",
    checkRun: "https://github.com/iterate/iterate/runs/1",
  });
  const check = checkRunOf(github.posted);
  expect(check).toMatchObject({
    conclusion: "neutral",
    external_id: `${job.key}:failed`,
    output: { title: "Not linted" },
  });
  expect(check.output.summary).toMatch(
    /^The lint failed before it had anything to publish: GitHub GET \/repos\/iterate\/iterate\/contents\/rules\?ref=base1: 404/,
  );
});

/** What a fake GitHub answers: a status and a body (a string as it is, anything else as JSON). */
type Route = { status: number; body: unknown };
/** A POST the lint made: its path and JSON body. */
type Posted = { path: string; body: Record<string, any>; url: string };

/** An LLM rule with no `select`: the LLM reads the whole diff for it. */
const WHOLE_DIFF_RULE =
  "---\nid: t/whole-diff\nseverity: warning\nfiles: ['**/*.ts']\n---\nAny rule.\n";

/** GitHub's REST API as the lint reads it: the pull request, the rules folder (`rulesFolder`,
 *  `rules` by default) served from fixtures/rules plus `extraRules`, and one changed file holding
 *  `source`, listed with `alsoListed` after it, 100 a page. `fail` answers a request instead, by
 *  method and path. */
function fakeGithub(options: {
  source?: string;
  rulesFolder?: string;
  extraRules?: Record<string, string>;
  alsoListed?: unknown[];
  fail?: (method: string, path: string) => Route | undefined;
}) {
  const source = options.source || SOURCE;
  const rulesFolder = options.rulesFolder || "rules";
  const extraRules = options.extraRules || {};
  const lines = source.split("\n");
  const patch = `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`;
  const listed = [
    { filename: "src/read.ts", status: "added", patch },
    ...(options.alsoListed || []),
  ];
  const posted: Posted[] = [];
  const answer = (route: Route) => ({
    status: route.status,
    text: typeof route.body === "string" ? route.body : JSON.stringify(route.body),
  });
  const rule = (path: string): Route => {
    if (extraRules[path] !== undefined) return { status: 200, body: extraRules[path] };
    const onDisk = join(import.meta.dirname, "fixtures/rules", path.slice(rulesFolder.length));
    if (!existsSync(onDisk)) return { status: 404, body: { message: "Not Found" } };
    if (!statSync(onDisk).isDirectory()) return { status: 200, body: readFileSync(onDisk, "utf8") };
    const entries = readdirSync(onDisk).map((name) => ({
      path: `${path}/${name}`,
      type: statSync(join(onDisk, name)).isDirectory() ? "dir" : "file",
    }));
    const extraHere = Object.keys(extraRules)
      .filter((name) => name.slice(0, name.lastIndexOf("/")) === path)
      .map((name) => ({ path: name, type: "file" }));
    return { status: 200, body: [...entries, ...extraHere] };
  };
  const get = (path: string, search: URLSearchParams): Route => {
    const ref = search.get("ref");
    if (path === `${REPO}/pulls/7`)
      return { status: 200, body: { state: "open", draft: false, head: { sha: "head1" } } };
    if (path === `${REPO}/commits/head1/check-runs`)
      return { status: 200, body: { check_runs: [] } };
    if (path === `${REPO}/pulls/7/files`) {
      const page = Number(search.get("page"));
      return { status: 200, body: listed.slice((page - 1) * 100, page * 100) };
    }
    if (path === `${REPO}/pulls/7/reviews`)
      return {
        status: 200,
        body: posted
          .filter((post) => post.path === path)
          .map((post) => ({
            html_url: post.url,
            body: post.body.body,
            user: { login: "iterate[bot]" },
          })),
      };
    if (path === `${REPO}/contents/src/read.ts` && ref === "head1")
      return { status: 200, body: source };
    const contents = `${REPO}/contents/`;
    if (path.startsWith(`${contents}${rulesFolder}`) && ref === "base1")
      return rule(path.slice(contents.length));
    return { status: 404, body: { message: `no route for GET ${path}` } };
  };
  const fetch: LintIo["fetch"] = async (request) => {
    const url = new URL(request.url);
    const failure = options.fail?.(request.method, url.pathname);
    if (failure) return answer(failure);
    if (request.method === "GET") return answer(get(url.pathname, url.searchParams));
    // the lint posts JSON objects only: a review or a Check Run
    const body = (await request.json()) as Record<string, any>;
    const reviews = posted.filter((post) => post.path === `${REPO}/pulls/7/reviews`).length;
    const reviewUrl = `https://github.com/iterate/iterate/pull/7#pullrequestreview-${reviews + 1}`;
    posted.push({ path: url.pathname, body, url: reviewUrl });
    if (url.pathname === `${REPO}/pulls/7/reviews`)
      return answer({
        status: 200,
        body: { html_url: reviewUrl, body: body.body, user: { login: "iterate[bot]" } },
      });
    return answer({ status: 201, body: { html_url: "https://github.com/iterate/iterate/runs/1" } });
  };
  return { fetch, posted };
}

/** The lint's I/O over `github`, the LLM and Jev answering as `llm` and `jev` (by default: the LLM
 *  finds the comment repeats an explanation and confirms any cast it is asked about; Jev is sure of a
 *  comment, unsure of a cast, clear of the rest), counting the calls to each. */
function io(options: {
  github: ReturnType<typeof fakeGithub>;
  llm?: (input: unknown) => unknown;
  jev?: (input: unknown) => unknown;
  /** What the lint remembers, kept across its runs as the host's storage keeps it. */
  remembered?: Map<string, unknown>;
}) {
  const calls = { llm: 0, jev: 0 };
  const remembered = options.remembered || new Map<string, unknown>();
  const lintIo: LintIo = {
    async remember<T>(key: string, compute: () => Promise<T>) {
      if (remembered.has(key)) return remembered.get(key) as T; // put below by the same key
      const value = await compute();
      remembered.set(key, value);
      return value;
    },
    fetch: options.github.fetch,
    async model(model, input) {
      if (model === "typesafe/jev") {
        calls.jev++;
        return (options.jev || jevAnswers)(input);
      }
      calls.llm++;
      return (options.llm || llmAnswers)(input);
    },
    projectId: async () => "prj_test",
    sleep: async () => {},
  };
  return { lintIo, calls };
}

function jevAnswers(input: unknown) {
  // the request jevRequest built: its state names what it judges
  const { state } = input as { state: string };
  let p = 0.1;
  if (state.includes("The comment under review")) p = 0.9;
  if (state.includes("Assertion under review")) p = 0.8;
  return { result: { answers: { v: { noul: p } }, usage: { input_tokens: 800 } } };
}

function llmAnswers(input: unknown) {
  const asked = JSON.stringify(input);
  const diagnostic = (rule: string, line: number, message: string) => ({
    rule,
    path: "src/read.ts",
    startLine: line,
    endLine: line,
    message,
    suggestion: null,
    key: `${rule}:src/read.ts:${line}`,
  });
  const diagnostics = [
    ...(asked.includes("comments/no-repeated-explanations")
      ? [diagnostic("comments/no-repeated-explanations", 2, "Said elsewhere.")]
      : []),
    ...(asked.includes("typescript/explain-type-cast")
      ? [diagnostic("typescript/explain-type-cast", 4, "Unexplained.")]
      : []),
  ];
  return {
    output_text: JSON.stringify({ summary: "Read it.", diagnostics }),
    usage: { input_tokens: 10, output_tokens: 2 },
  };
}

function checkRunOf(posted: Posted[]) {
  return posted.find((post) => post.path === `${REPO}/check-runs`)!.body;
}

function reviewOf(posted: Posted[]) {
  return posted.find((post) => post.path === `${REPO}/pulls/7/reviews`)!.body;
}

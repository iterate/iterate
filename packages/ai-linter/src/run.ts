// ai-linter/run.ts — one lint of one pull request head, its I/O handed in: GitHub's REST API through
// the project's egress, the models through its Workers AI binding, the project's id and a clock.
// processor.ts queues the heads and hands this the real I/O; run.test.ts hands it fakes.
//
// A rule is decided by one of two engines (lint.ts `Rule`). The LLM reads the diff with every LLM
// rule's prose, in one call. Jev (`typesafe/jev` on Workers AI) judges each unit a Jev rule's selector
// picks on an added line, one request per unit (jev.ts says why); a p between the rule's pass and
// flag is left to the LLM, in one more call holding only those units' windows and their rules' prose.
//
// POST WHAT IT HAS. Each part that can fail on its own settles on its own, and a failed part never
// takes the others' results with it: the LLM rules' call, the Jev stage, each Jev unit, the LLM's call
// on the units Jev left unsure, each rule file, each changed file read, the review and the Check Run.
// What did not run is listed at the top of the Check Run and the review (lint.ts `problemLines`) and
// makes the Check Run neutral and not the head's final verdict, so the head is linted again when it
// is delivered again. A lint that fails before it has anything to publish (the pull request, its
// files or the rules folder unreadable) posts a Check Run saying so.
//
// Every model call names the project, so the gateway's per-project cap bounds what the linter spends
// and it never uses up the budget every project's agents share.
import { z } from "zod";
import {
  CHECK_NAME,
  MAX_DIFF_CHARS,
  RESULT_SCHEMA,
  checkRunOutput,
  isRuleFile,
  isSuppressed,
  keepDiagnostics,
  lintPolicy,
  lintTask,
  modelText,
  parseResult,
  parseRule,
  problemLines,
  reviewBody,
  reviewComments,
  rightSide,
  ruleApplies,
  type Finding,
  type JevRule,
  type JevStats,
  type Problem,
  type ReviewedFile,
  type Rule,
} from "./lint.ts";
import {
  assess,
  confirmedEscalations,
  escalationFiles,
  jevAnswer,
  jevFinding,
  jevRequest,
  selectUnits,
  sourceFile,
  unitExcerpts,
  type Candidate,
} from "./jev.ts";

/** The model the LLM rules and Jev's unsure units go to, unless the install names another. */
export const DEFAULT_MODEL = "openai/gpt-6-astra";
/** The most changed files read from one pull request (GitHub lists 3,000 at most). */
const MAX_FILES = 1_000;
/** The most units Jev judges on one head, ~100 s at the pace below; the rest are listed as not judged. */
const MAX_JEV_CANDIDATES = 600;
/** Jev requests in flight at once; `pacer` starts them 170 ms apart: at most 6 a second, 360 a
 *  minute, under a third of the account's 1,200 a minute that every Jev caller shares. */
const JEV_CONCURRENCY = 6;
/** Tries per Jev request, the waits between them doubling from 2 s (30 s in all). */
const JEV_TRIES = 5;
/** Units in a row that failed every try, after which the rest are not asked: the account's limit
 *  (through the binding it answers "2018: Invalid User Credentials") or an outage refuses every unit
 *  alike, and each costs 30 s of tries, so 600 of them would hold the lint for most of an hour. */
const JEV_GIVE_UP_AFTER = 12;
/** Files read from GitHub at once. */
const FILE_CONCURRENCY = 8;

/** One head of one pull request, as the processor queued it. */
export type Job = {
  key: string;
  connection: string;
  repository: string;
  number: number;
  headSha: string;
  baseSha: string;
};

/** What the install chose: the repository's rules folder, and the model for the LLM rules and Jev's
 *  unsure units. */
export type LintConfig = { rules: string; model: string };

/** The AI Gateway every model call goes through, and what it logs: the project, whose daily cap
 *  bounds the linter, the app and the pull request head. */
export type Gateway = {
  id: string;
  metadata: { projectId: string; app: string; pullRequest: string };
};

/** The lint's I/O. `fetch` answers the status and the whole body, read before the call returns.
 *  `remember` answers what `compute` answered the last time this head's lint asked under `key`, kept
 *  where a restart does not lose it, else computes and keeps it: a lint the platform restarts (a
 *  deploy lands mid-lint) runs again from the start, and must not pay for the LLM twice. */
export type LintIo = {
  fetch(request: Request): Promise<{ status: number; text: string }>;
  model(model: string, input: unknown, options: { gateway: Gateway }): Promise<unknown>;
  remember<T>(key: string, compute: () => Promise<T>): Promise<T>;
  projectId(): Promise<unknown>;
  sleep(ms: number): Promise<void>;
};

const PullRequest = z.object({
  state: z.string(),
  draft: z.boolean().optional(),
  head: z.object({ sha: z.string() }),
});
const ChangedFile = z.object({
  filename: z.string(),
  status: z.string(),
  patch: z.string().optional(),
});
const ContentEntry = z.object({ path: z.string(), type: z.string() });
const CheckRun = z.object({ html_url: z.string().nullable() });
/** A Responses API answer's token counts. */
const ModelUsage = z.object({
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

/** The SHA-256 of `text`, hex. */
async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `work`'s value, or its error's message: a part of the lint that fails on its own. */
const settle = <T>(work: () => Promise<T>): Promise<{ value: T } | { error: string }> =>
  work().then(
    (value) => ({ value }),
    (error: unknown) => ({ error: errorMessage(error) }),
  );

/** Lint `job`'s head and publish the verdict; the outcome for `ai-linter/linted`. Never throws. */
export async function lintHead(
  job: Job,
  config: LintConfig,
  io: LintIo,
): Promise<Record<string, unknown>> {
  const github = githubApi(io, job.connection);
  try {
    return await lint(job, config, io, github);
  } catch (caught) {
    const error = errorMessage(caught).slice(0, 2_000);
    // Its external_id is not the head's key, so the next delivery of this head lints it again.
    const checkRun = await settle(
      async () =>
        CheckRun.parse(
          await github("POST", `/repos/${job.repository}/check-runs`, {
            name: CHECK_NAME,
            head_sha: job.headSha,
            status: "completed",
            conclusion: "neutral",
            external_id: `${job.key}:failed`,
            output: {
              title: "Not linted",
              summary: `The lint failed before it had anything to publish: ${error}`,
            },
          }),
        ).html_url,
    );
    return {
      status: "failed",
      error,
      ...("value" in checkRun
        ? { checkRun: checkRun.value }
        : { checkRun: null, checkRunError: checkRun.error.slice(0, 500) }),
    };
  }
}

async function lint(job: Job, config: LintConfig, io: LintIo, github: GithubApi) {
  const startedAt = Date.now();
  const repo = `/repos/${job.repository}`;
  const current = async () => {
    const pull = PullRequest.parse(await github("GET", `${repo}/pulls/${job.number}`));
    return pull.state === "open" && pull.draft !== true && pull.head.sha === job.headSha;
  };
  if (!(await current())) return { status: "skipped", reason: "the pull request moved on" };
  const checks = z
    .object({ check_runs: z.array(z.object({ external_id: z.string().nullable() })) })
    .parse(
      await github(
        "GET",
        `${repo}/commits/${job.headSha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=all&per_page=100`,
      ),
    );
  if (checks.check_runs.some((run) => run.external_id === job.key))
    return { status: "skipped", reason: "this head already has its Check Run" };

  const problems: Problem[] = [];
  const rules = await readRules(github, repo, job.baseSha, config.rules, problems);
  const llmRules = rules.filter((rule) => rule.engine === "llm");
  const jevRules = rules.filter((rule): rule is JevRule => rule.engine === "jev");
  const changed: z.infer<typeof ChangedFile>[] = [];
  // GitHub can list a changed file without its filename and status: it is counted, not linted.
  let unnamed = 0;
  for (let page = 1; changed.length + unnamed < MAX_FILES; page++) {
    const batch = z
      .array(ChangedFile.nullable().catch(null))
      .parse(await github("GET", `${repo}/pulls/${job.number}/files?per_page=100&page=${page}`));
    for (const file of batch) {
      if (file) changed.push(file);
      else unnamed++;
    }
    if (batch.length < 100) break;
  }
  if (unnamed > 0)
    problems.push({
      stage: "file",
      error: `Not linted: ${unnamed} of the changed files GitHub listed came without a filename or status`,
    });
  // `reviewed`: the files the LLM reads whole, for its rules; `excerpted`: those whose LLM rules all
  // select, which it reads as excerpts (`excerptsOf`); `judged`: the files Jev's rules select in.
  const reviewed: ReviewedFile[] = [];
  const excerpted: ReviewedFile[] = [];
  const judged: ReviewedFile[] = [];
  const notReviewed: string[] = [];
  let diffChars = 0;
  for (const file of changed) {
    if (file.status === "removed") continue;
    const applicable = (engineRules: Rule[]) =>
      engineRules.filter((rule) => ruleApplies(rule, file.filename)).map((rule) => rule.id);
    const [forLlm, forJev] = [applicable(llmRules), applicable(jevRules)];
    if (forLlm.length === 0 && forJev.length === 0) continue;
    if (!file.patch) {
      notReviewed.push(file.filename);
      continue;
    }
    if (forJev.length) judged.push({ path: file.filename, patch: file.patch, rules: forJev });
    if (forLlm.length === 0) continue;
    if (llmRules.every((rule) => !forLlm.includes(rule.id) || rule.select)) {
      excerpted.push({ path: file.filename, patch: file.patch, rules: forLlm });
      continue;
    }
    if (diffChars + file.patch.length > MAX_DIFF_CHARS) {
      notReviewed.push(file.filename);
      continue;
    }
    diffChars += file.patch.length;
    reviewed.push({ path: file.filename, patch: file.patch, rules: forLlm });
  }
  const used = rules.filter((rule) =>
    [...reviewed, ...excerpted, ...judged].some((file) => file.rules.includes(rule.id)),
  );
  const rulesOf = (files: ReviewedFile[]) =>
    used.filter((rule) => files.some((file) => file.rules.includes(rule.id)));

  // A file at the head, read once: Jev's selectors read it whole, and a suppression can sit anywhere.
  // A file that cannot be read is left out: Jev does not judge it and its findings keep no
  // suppression (keepDiagnostics reads a missing source as empty); it is a problem once, below.
  const reads = new Map<string, Promise<string>>();
  const sourceOf = (path: string) => {
    let read = reads.get(path);
    if (!read) {
      read = github(
        "GET",
        `${repo}/contents/${encodePath(path)}?ref=${job.headSha}`,
        undefined,
        "raw",
      );
      reads.set(path, read);
    }
    return read.catch(() => null);
  };
  const sources = async (paths: Iterable<string>) => {
    const read = await Promise.all(
      [...new Set(paths)].map(async (path) => [path, await sourceOf(path)] as const),
    );
    return new Map(read.filter((entry): entry is [string, string] => entry[1] !== null));
  };
  // The project names the spend, so the gateway's per-project cap bounds the linter and it never
  // uses up the budget every project's agents share. Without it the cap does not apply, so no
  // model is called.
  const projectId = await io.projectId();
  if (typeof projectId !== "string" || !projectId)
    throw new Error(
      "this context names no project, so the AI Gateway's per-project cap could not bound the lint",
    );
  const gateway: Gateway = {
    id: "default",
    metadata: { projectId, app: "ai-linter", pullRequest: job.key },
  };
  const usage = { llmCalls: 0, llmInputTokens: 0, llmOutputTokens: 0 };
  // Each LLM request's answer is remembered by the request, so a lint run again after a restart
  // reads the answers it already paid for; only what it counts on is kept (the text).
  const askLlm = async (rulesAsked: Rule[], files: ReviewedFile[]) => {
    const request = {
      input: [
        { role: "system", content: lintPolicy(job.repository) },
        { role: "user", content: lintTask(rulesAsked, files) },
      ],
      store: false,
      reasoning: { effort: "medium" },
      text: {
        format: { type: "json_schema", name: "lint_result", strict: true, schema: RESULT_SCHEMA },
      },
    };
    const requestHash = await sha256(JSON.stringify([config.model, request]));
    const text = await io.remember(`llm/${requestHash}`, async () => {
      const answer = await io.model(config.model, request, { gateway });
      const counted = ModelUsage.safeParse(answer);
      usage.llmCalls++;
      usage.llmInputTokens += counted.success ? counted.data.usage.input_tokens : 0;
      usage.llmOutputTokens += counted.success ? counted.data.usage.output_tokens : 0;
      return modelText(answer);
    });
    return parseResult(text);
  };

  // An excerpted file as the LLM reads it: the units its LLM rules select on added lines, each with
  // its rule's window around it; a file with none is not read. The excerpts share the diff's budget.
  const excerptsOf = async (files: ReviewedFile[]) => {
    const units = [];
    for (const file of files) {
      const text = await sourceOf(file.path);
      if (!text) continue; // listed as a problem below
      const source = sourceFile(file.path, text, rightSide(file.patch).added);
      for (const rule of llmRules)
        if (rule.select && file.rules.includes(rule.id))
          for (const unit of selectUnits(rule.select, source))
            units.push({ rule, file: source, unit, window: rule.window });
    }
    const read: ReviewedFile[] = [];
    for (const file of unitExcerpts(units)) {
      if (diffChars + file.patch.length > MAX_DIFF_CHARS) {
        notReviewed.push(file.path);
        continue;
      }
      diffChars += file.patch.length;
      read.push({ ...file, excerpts: true });
    }
    return read;
  };

  // The LLM rules' call runs beside Jev and its call for the units Jev left unsure. With nothing to
  // read (no file read whole, no unit selected), it is not made.
  const llmFindings = async () => {
    const asked = [...reviewed, ...(await excerptsOf(excerpted))];
    if (asked.length === 0) return null;
    const result = await askLlm(rulesOf(asked), asked);
    const paths = result.diagnostics.map((diagnostic) => diagnostic.path);
    // A finding lands on the pull request's diff, whatever the LLM read of the file.
    const files = [...reviewed, ...excerpted];
    const { kept, dropped } = keepDiagnostics({
      diagnostics: result.diagnostics.map((diagnostic): Finding => ({
        ...diagnostic,
        decidedBy: { engine: "llm", p: null },
      })),
      files,
      rules: used,
      sources: await sources(paths.filter((path) => files.some((file) => file.path === path))),
    });
    return { summary: result.summary, findings: kept, dropped: dropped.length };
  };
  const jevFindings = async () => {
    const start = pacer(io);
    const { flagged, escalated, stats } = await judge(judged, jevRules, sourceOf, (request) =>
      askJev(io, request, gateway, start),
    );
    const patchOf = (path: string) => judged.find((file) => file.path === path)?.patch ?? "";
    const decided = flagged.map(({ candidate, p }) =>
      jevFinding(candidate, patchOf(candidate.file.path), { engine: "jev", p }),
    );
    if (escalated.length > 0) {
      const candidates = escalated.map(({ candidate }) => candidate);
      const asked = escalationFiles(candidates);
      const answer = await settle(() => askLlm(rulesOf(asked), asked));
      if ("error" in answer)
        problems.push({ stage: "escalation", error: answer.error, units: escalated.length });
      else {
        const confirmed = new Set(confirmedEscalations(candidates, answer.value.diagnostics));
        for (const { candidate, p } of escalated)
          if (confirmed.has(candidate))
            decided.push(jevFinding(candidate, patchOf(candidate.file.path), { engine: "llm", p }));
      }
    }
    const { kept, dropped } = keepDiagnostics({
      diagnostics: decided,
      files: judged,
      rules: used,
      sources: await sources(decided.map((finding) => finding.path)),
    });
    return { stats, findings: kept, dropped: dropped.length };
  };
  const [llm, jev] = await Promise.all([
    reviewed.length > 0 || excerpted.length > 0 ? settle(llmFindings) : null,
    judged.length > 0 ? settle(jevFindings) : null,
  ]);
  if (llm && "error" in llm)
    problems.push({
      stage: "llm",
      error: llm.error,
      rules: rulesOf([...reviewed, ...excerpted]).map((rule) => rule.id),
    });
  if (jev && "error" in jev)
    problems.push({
      stage: "jev",
      error: jev.error,
      rules: rulesOf(judged).map((rule) => rule.id),
    });
  const llmResult = llm && "value" in llm ? llm.value : null;
  const jevResult = jev && "value" in jev ? jev.value : null;
  const findings = [...(llmResult?.findings || []), ...(jevResult?.findings || [])];
  const dropped = (llmResult?.dropped ?? 0) + (jevResult?.dropped ?? 0);
  const jevStats = jevResult?.stats || null;
  const covered = reviewed.length > 0 || excerpted.length > 0 || judged.length > 0;
  const summary = llmResult?.summary || (covered ? "" : "No changed file is covered by a rule.");
  for (const [path, read] of reads) {
    const error = await read.then(
      () => null,
      (caught: unknown) => errorMessage(caught),
    );
    if (!error) continue;
    const lost = [
      judged.some((file) => file.path === path) && "Jev did not judge it",
      excerpted.some((file) => file.path === path)
        ? "the LLM did not read it"
        : "its suppressions were not applied",
    ].filter((part) => part !== false);
    problems.push({
      stage: "file",
      error: `${path} could not be read, so ${lost.join(" and ")}: ${error}`,
    });
  }

  // A pull request that cannot be read now is published on anyway: its verdict is for this head.
  if (!(await current().catch(() => true)))
    return { status: "skipped", reason: "the pull request moved on" };
  // The review is marked with the head and what it says, its findings and what did not run: a lint that
  // died between the review and the Check Run finds its review again and posts none, and a head
  // linted again after an incomplete verdict posts its own review, since what it says differs.
  const reviewProblems = problemLines(problems, jevStats);
  const reviewDigest = await sha256(
    JSON.stringify([
      findings.map((finding) => [finding.rule, finding.path, finding.startLine, finding.message]),
      reviewProblems,
    ]),
  );
  const marker = `<!-- ${job.key} ${reviewDigest.slice(0, 16)} -->`;
  // The review first, the Check Run last: a head with its complete Check Run is done, so a lint that
  // died between the two posts the review again, and the marker makes that a no-op.
  let reviewUrl: string | null = null;
  if (findings.length > 0) {
    const review = await settle(() =>
      postReview(github, repo, job, {
        marker,
        summary,
        diagnostics: findings,
        rules: used,
        notReviewed,
        problems: reviewProblems,
      }),
    );
    if ("error" in review) problems.push({ stage: "review", error: review.error });
    else reviewUrl = review.value;
  }
  const output = checkRunOutput({
    summary,
    findings,
    jev: jevStats,
    problems,
    reviewUrl,
    notReviewed,
    rules: used,
    repository: job.repository,
    baseSha: job.baseSha,
  });
  const checkRun = await settle(
    async () =>
      CheckRun.parse(
        await github("POST", `${repo}/check-runs`, {
          name: CHECK_NAME,
          head_sha: job.headSha,
          status: "completed",
          conclusion: output.conclusion,
          // Only a complete verdict is the head's: a head whose Check Run is incomplete is linted again
          // when it is delivered again (reopened, readied).
          external_id: output.complete ? job.key : `${job.key}:incomplete`,
          output: { title: output.title, summary: output.summary },
        }),
      ).html_url,
  );
  return {
    status: "value" in checkRun ? "linted" : "failed",
    ...("error" in checkRun && {
      error: `the Check Run was not posted: ${checkRun.error.slice(0, 500)}`,
    }),
    conclusion: output.conclusion,
    title: output.title,
    findings: findings.length,
    byEngine: {
      jev: findings.filter((finding) => finding.decidedBy.engine === "jev").length,
      llm: findings.filter((finding) => finding.decidedBy.engine === "llm").length,
    },
    dropped,
    checkRun: "value" in checkRun ? checkRun.value : null,
    review: reviewUrl,
    problems: problems.map((problem) => ({ ...problem, error: problem.error.slice(0, 500) })),
    notReviewed,
    jev: jevStats,
    usage: { ...usage, jevInputTokens: jevStats?.inputTokens ?? 0 },
    ms: Date.now() - startedAt,
  };
}

/** A unit Jev judged, and its p. */
type Judged = { candidate: Candidate; p: number };

/** The selectors that read the file's syntax tree, so a file that does not parse has none. */
const AST_SELECTORS: JevRule["select"]["kind"][] = ["cast", "conditional", "shape"];

/** Jev on every unit its rules select in the judged files: one request per unit, a few at once. A
 *  file `sourceOf` cannot read (null) is skipped; a unit Jev never answers is listed as not judged,
 *  and once JEV_GIVE_UP_AFTER units in a row have failed, the rest are not asked. */
async function judge(
  judged: ReviewedFile[],
  jevRules: JevRule[],
  sourceOf: (path: string) => Promise<string | null>,
  ask: (request: unknown) => Promise<{ p: number; inputTokens: number } | { error: string }>,
): Promise<{ flagged: Judged[]; escalated: Judged[]; stats: JevStats }> {
  const notJudged: string[] = [];
  const candidates: Candidate[] = [];
  const files = await pool(judged, FILE_CONCURRENCY, async (reviewedFile) => {
    const text = await sourceOf(reviewedFile.path);
    if (!text) return null;
    return {
      rules: jevRules.filter((rule) => reviewedFile.rules.includes(rule.id)),
      file: sourceFile(reviewedFile.path, text, rightSide(reviewedFile.patch).added),
    };
  });
  for (const entry of files) {
    if (!entry) continue;
    const { rules, file } = entry;
    if (rules.some((rule) => AST_SELECTORS.includes(rule.select.kind)) && file.parseError())
      notJudged.push(`${file.path} does not parse (${file.parseError()?.slice(0, 120)})`);
    for (const rule of rules)
      for (const unit of selectUnits(rule.select, file)) {
        let suppressed = false;
        for (let line = unit.start; line <= unit.end; line++)
          if (isSuppressed(file.text, line, rule.id)) suppressed = true;
        if (!suppressed) candidates.push({ rule, file, unit });
      }
  }
  if (candidates.length > MAX_JEV_CANDIDATES)
    notJudged.push(
      `${candidates.length - MAX_JEV_CANDIDATES} units past the first ${MAX_JEV_CANDIDATES}`,
    );
  const asked = candidates.slice(0, MAX_JEV_CANDIDATES);
  let failedInARow = 0;
  let notAsked = 0;
  const answered = await pool(asked, JEV_CONCURRENCY, async (candidate) => {
    if (failedInARow >= JEV_GIVE_UP_AFTER) {
      notAsked++;
      return { candidate, answer: null };
    }
    const answer = await ask(jevRequest(candidate.rule, candidate.file, candidate.unit));
    failedInARow = "error" in answer ? failedInARow + 1 : 0;
    return { candidate, answer };
  });
  const flagged: Judged[] = [];
  const escalated: Judged[] = [];
  const unanswered: string[] = [];
  let passed = 0;
  let inputTokens = 0;
  for (const { candidate, answer } of answered) {
    if (!answer) continue;
    if ("error" in answer) {
      unanswered.push(answer.error);
      continue;
    }
    const { p } = answer;
    inputTokens += answer.inputTokens;
    const verdict = assess(candidate.rule, p);
    if (verdict === "flag") flagged.push({ candidate, p });
    else if (verdict === "escalate") escalated.push({ candidate, p });
    else passed++;
  }
  if (unanswered.length)
    notJudged.push(
      `${unanswered.length} units Jev did not answer in ${JEV_TRIES} tries (${unanswered[0]?.slice(0, 120)})`,
    );
  if (notAsked)
    notJudged.push(
      `${notAsked} units not asked, after ${JEV_GIVE_UP_AFTER} in a row went unanswered`,
    );
  return {
    flagged,
    escalated,
    stats: {
      units: candidates.length,
      judged: asked.length - unanswered.length - notAsked,
      inputTokens,
      flagged: flagged.length,
      escalated: escalated.length,
      passed,
      failed: unanswered.length + notAsked,
      notJudged,
    },
  };
}

/** Starts Jev's requests 170 ms apart (JEV_CONCURRENCY says why): resolves when the next may start. */
function pacer(io: LintIo) {
  let nextStart = 0;
  return async () => {
    const at = Math.max(Date.now(), nextStart);
    nextStart = at + 170;
    await io.sleep(at - Date.now());
  };
}

/** One Jev request, paced and tried up to JEV_TRIES times (a 429 or the account's limit when its
 *  minute is full, a lost call); the last error when every try failed. */
async function askJev(io: LintIo, request: unknown, gateway: Gateway, start: () => Promise<void>) {
  let error: unknown;
  for (let attempt = 1; attempt <= JEV_TRIES; attempt++) {
    if (attempt > 1) await io.sleep(2_000 * 2 ** (attempt - 2));
    await start();
    try {
      return jevAnswer(await io.model("typesafe/jev", request, { gateway }));
    } catch (caught) {
      error = caught;
    }
  }
  return { error: errorMessage(error) };
}

/** Every `<folder>/**\/*.md` of the repository at `ref`. A rule file that cannot be read or parsed is
 *  a problem and the other rules still run; a folder that cannot be listed fails the lint. */
async function readRules(
  github: GithubApi,
  repo: string,
  ref: string,
  folder: string,
  problems: Problem[],
): Promise<Rule[]> {
  const rules: Rule[] = [];
  const directories = [folder];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    const entries = z
      .array(ContentEntry)
      .parse(await github("GET", `${repo}/contents/${encodePath(directory)}?ref=${ref}`));
    for (const entry of entries) {
      if (entry.type === "dir") directories.push(entry.path);
      else if (entry.type === "file" && isRuleFile(entry.path)) {
        const rule = await settle(async () =>
          parseRule(
            entry.path,
            await github(
              "GET",
              `${repo}/contents/${encodePath(entry.path)}?ref=${ref}`,
              undefined,
              "raw",
            ),
          ),
        );
        if ("error" in rule) problems.push({ stage: "rule", error: rule.error });
        else rules.push(rule.value);
      }
    }
  }
  return rules;
}

/** The one COMMENT review for this head: found by its marker (from an App's bot only, since a person
 *  could paste it; only an App's account ends in `[bot]`), else posted; with the findings in the body
 *  alone when GitHub refuses an inline location. */
async function postReview(
  github: GithubApi,
  repo: string,
  job: Job,
  input: Parameters<typeof reviewBody>[0] & { diagnostics: Finding[] },
): Promise<string> {
  const Review = z.object({
    html_url: z.string(),
    body: z.string().nullable(),
    user: z.object({ login: z.string() }).nullable(),
  });
  for (let page = 1; page <= 10; page++) {
    const reviews = z
      .array(Review)
      .parse(await github("GET", `${repo}/pulls/${job.number}/reviews?per_page=100&page=${page}`));
    const existing = reviews.find(
      (review) =>
        review.user?.login.endsWith("[bot]") === true &&
        review.body?.includes(input.marker) === true,
    );
    if (existing) return existing.html_url;
    if (reviews.length < 100) break;
  }
  const body = reviewBody(input);
  const post = async (comments: unknown[]) =>
    Review.parse(
      await github("POST", `${repo}/pulls/${job.number}/reviews`, {
        commit_id: job.headSha,
        event: "COMMENT",
        body,
        comments,
      }),
    ).html_url;
  try {
    return await post(reviewComments(input.diagnostics));
  } catch (error) {
    if (!(error instanceof GithubError) || error.status !== 422) throw error;
    return await post([]);
  }
}

class GithubError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type GithubApi = ReturnType<typeof githubApi>;

/** GitHub's REST API as the connection's installation: the token is a `getSecret` placeholder that
 *  the project's egress replaces, so it never enters this isolate. `raw` answers the file's text. */
function githubApi(io: LintIo, connection: string) {
  return async (method: string, path: string, body?: unknown, accept?: "raw"): Promise<any> => {
    // A GET that met a server error or a lost connection is tried twice more; anything else once.
    let answer: { status: number; text: string } | undefined;
    for (let attempt = 1; !answer; attempt++) {
      const result = await io
        .fetch(
          new Request(`https://api.github.com${path}`, {
            method,
            headers: {
              accept:
                accept === "raw"
                  ? "application/vnd.github.raw+json"
                  : "application/vnd.github+json",
              authorization: `Bearer getSecret("/secrets/github-${connection}", { field: "accessToken" })`,
              "user-agent": "iterate-ai-linter",
              "x-github-api-version": "2022-11-28",
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
        .catch((error: unknown) => ({ status: 0, text: String(error) }));
      if (method === "GET" && attempt < 3 && (result.status === 0 || result.status >= 500))
        await io.sleep(attempt * 2_000);
      else answer = result;
    }
    const { status, text } = answer;
    // 0 is a connection that failed on every attempt.
    if (status < 200 || status >= 300)
      throw new GithubError(`GitHub ${method} ${path}: ${status} ${text.slice(0, 500)}`, status);
    return accept === "raw" ? text : JSON.parse(text);
  };
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** `work` over `items`, at most `concurrency` at once, the results in the items' order. */
async function pool<T, R>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]!);
      }
    }),
  );
  return results;
}

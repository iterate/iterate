import { z } from "zod";
import type { RowState } from "../ci/dashboard.ts";
import { cutText, slackEscape } from "../ci/slack.ts";

/** A signal's state as its page tells it: green with no page open, or red, or unjudged (`broken`: a
 *  run that proved nothing), each with its own page. */
export const PageState = z.enum(["green", "red", "broken"]);
export type PageState = z.infer<typeof PageState>;

/** What a signal's verdict owes the channel (`decide`):
 *    post      open a page
 *    edit      edit the open page in place, which notifies nobody
 *    escalate  edit it and reply in today's dashboard thread, with both mentions: it got worse
 *    resolve   edit it to say resolved and why (../ci/slack.ts `resolvedPageText`), which
 *              notifies nobody
 *    replace   resolve the open page and open another: red and unjudged are two incidents, so an
 *              unjudged page never hides a red one */
export type PageAction = "post" | "edit" | "escalate" | "resolve" | "replace";

/** The action a signal's verdict `next` owes, given the state its page told: `worse` when the
 *  verdict is worse than the open page says. No previous state is green: nothing has paged. Pure. */
export function decide(
  previous: PageState | undefined,
  next: PageState,
  worse: boolean,
): PageAction | null {
  const was = previous || "green";
  if (was === "green") return next === "green" ? null : "post";
  if (next === "green") return "resolve";
  if (next !== was) return "replace";
  return worse ? "escalate" : "edit";
}

/** A signal as its job's state remembers it: green, or red or unjudged since a commit, over how many
 *  runs, and every failure its open page has named. */
export const SignalMemory = z.discriminatedUnion("state", [
  z.object({ state: z.literal("green") }),
  z.object({
    state: z.enum(["red", "broken"]),
    since: z.string(),
    runs: z.number().int().positive(),
    failures: z.array(z.string()),
  }),
]);
export type SignalMemory = z.infer<typeof SignalMemory>;

/** One run's verdict against the signal's memory: the action it owes (`decide`, worse when it names
 *  a failure the open page has not), the failures that are new, and the memory after it. Pure. */
export function advance(
  previous: SignalMemory | undefined,
  verdict: { state: PageState; sha: string; failures: string[] },
) {
  const open = previous?.state === verdict.state && previous.state !== "green" ? previous : null;
  const news = open ? verdict.failures.filter((failure) => !open.failures.includes(failure)) : [];
  const action = decide(previous?.state, verdict.state, news.length > 0);
  const memory: SignalMemory =
    verdict.state === "green"
      ? { state: "green" }
      : open
        ? { ...open, runs: open.runs + 1, failures: [...open.failures, ...news] }
        : { state: verdict.state, since: verdict.sha, runs: 1, failures: verdict.failures };
  return { action, news, memory };
}

/** A page as #error-pulse reads it (scripts/ci/slack.ts `pageText`): what broke, who or what it
 *  affects, the first thing to do, and the run that measured it. */
export type PageContent = { what: string; impact: string; action: string; link?: string };

/** What one check tells the channel about one signal, keyed by the signal: its page is found by that
 *  key in the job's state (./health.ts `sendUpdates`). */
export type PageUpdate =
  | { signal: string; kind: "post" | "edit"; page: PageContent }
  | {
      signal: string;
      kind: "escalate";
      page: PageContent;
      /** The reply in today's dashboard thread: what got worse, naming the signal. */
      news: string;
    }
  | { signal: string; kind: "resolve"; why: string }
  | { signal: string; kind: "replace"; why: string; page: PageContent };

/** A commit as a page names it: its short sha and, when it could be read, its subject. Pure. */
export function commitText(commit: { sha: string; subject: string }) {
  const sha = shortSha(commit.sha);
  return commit.subject ? `${sha} (${slackEscape(commit.subject)})` : sha;
}

/** A commit as a dashboard row names it: commitText with the subject cut to 60 characters before
 *  it is escaped, so the row's own cut (../ci/dashboard.ts `renderDashboard`) never lands inside an
 *  escape. Pure. */
export function rowCommitText(commit: { sha: string; subject: string }) {
  return commitText({ sha: commit.sha, subject: cutText(commit.subject, 60) });
}

/** A signal's row on #error-pulse's daily dashboard as a run judged it, which only a real run on
 *  main sets, after its updates are sent (./health.ts `postThenKeep`, ../ci/dashboard.ts
 *  `setRow`). */
export type DashboardRow = { signal: string; state: RowState; text: string };

/** A sha as a page names it. Pure. */
export function shortSha(sha: string) {
  return `\`${sha.slice(0, 9)}\``;
}

/** How long a signal has been red or unjudged, for its page's impact: nothing on its first run.
 *  Pure. */
export function sinceText(memory: SignalMemory) {
  if (memory.state === "green" || memory.runs === 1) return "";
  return `; ${memory.state === "red" ? "red" : "unjudged"} since ${shortSha(memory.since)}, ${memory.runs} runs`;
}

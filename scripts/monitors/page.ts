import { slackEscape } from "../ci/slack.ts";

/** What one check tells the channel: a change of state, or on a test page its verdict now. The
 *  health job puts every page of a run in one message (./health.ts `renderMessage`). */
export type Page = {
  /** 🔴, 🟢, or ⚪ for a verdict a test page shows that is neither. */
  tone: "red" | "green" | "none";
  /** The page's first line, after its emoji: what changed, and where. */
  headline: string;
  /** One bullet each. */
  details: string[];
  /** The run that measured it. */
  link?: string;
};

/** A commit as a page names it: its short sha and, when it could be read, its subject. Pure. */
export function commitText(commit: { sha: string; subject: string }) {
  const sha = `\`${commit.sha.slice(0, 9)}\``;
  return commit.subject ? `${sha} (${slackEscape(commit.subject)})` : sha;
}

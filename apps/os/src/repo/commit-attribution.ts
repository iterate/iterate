// repo/commit-attribution.ts — WHO A COMMIT IS FOR, AS GIT SAYS IT. Every commit the platform makes is
// committed by `iterate` (`PLATFORM`), whoever wrote it. A commit a script makes for someone
// (../on-behalf-of.ts) is authored by them unless the script names an author, and its message ends
// with the run that made it (`Iterate-Run:`) and, when the script named someone else, them
// (`Requested-by:`). Which agent did the work is the agent's own word, a `Via:` line it ends its
// message with (the MCP instructions ask for it), as a Docs comment's `via` is.
import type { Principal } from "iterate/principal";
import type { OnBehalfOf } from "../on-behalf-of.ts";

/** The platform, as git names it: every commit's committer, and the author of a commit nobody
 *  asked for. */
export const PLATFORM = { email: "config@iterate.com", name: "iterate" };

/** A person as a commit's author: their email as name and address, as apps/docs `authorOf` writes
 *  it; none without an email, whose commit is the platform's. */
export function authorOf(principal: Principal | undefined) {
  return principal?.email ? { name: principal.email, email: principal.email } : undefined;
}

/** The trailers of a commit made for `onBehalfOf`, whose script named `namedAuthor` (or none). */
export function attributionTrailers(
  onBehalfOf: OnBehalfOf,
  namedAuthor: { email: string } | undefined,
): string[] {
  const { principal, run } = onBehalfOf;
  const requested = namedAuthor && namedAuthor.email !== principal.email;
  return [
    `Iterate-Run: ${run}`,
    ...(requested ? [`Requested-by: ${principal.email || principal.actor}`] : []),
  ];
}

/** `message` ending with `trailers` as git and GitHub read them: in its last paragraph when that
 *  paragraph is already trailers (an agent's `Via:`, Docs' `Co-authored-by:` lines), else in a
 *  paragraph of their own. The first paragraph is the subject, never trailers, though `docs: …`
 *  looks like one. */
export function withTrailers(message: string, trailers: string[]): string {
  if (trailers.length === 0) return message;
  const body = message.trimEnd();
  const paragraphs = body.split(/\n{2,}/);
  const lastIsTrailers =
    paragraphs.length > 1 &&
    paragraphs
      .at(-1)!
      .split("\n")
      .every((line) => /^[A-Za-z0-9-]+: \S/.test(line));
  return `${body}${lastIsTrailers ? "\n" : "\n\n"}${trailers.join("\n")}`;
}

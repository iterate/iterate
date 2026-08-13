// The <codemode> response format: parses one assistant response into prose,
// an optional status label, and one executable script.
//
// Vendored from the platform's response-format module
// (apps/os/src/domains/agents/agent-response-format.ts in iterate/iterate) so
// this template owns its whole format — iterating on the grammar is a commit
// to THIS repo, no platform deploy. Modifications from the original: the
// fenced-ts format is dropped; the outcome type is inlined; everything else
// (line-anchored tags, last-closer rule, async-body passthrough) matches.
//
// The grammar this parses:
//
//   Markdown prose the user will see.
//
//   <codemode status="Checking your files">
//   const foo = await itx.doWhatever()
//   return { abc: foo.bar }
//   </codemode>
//
//   Optional trailing prose, also delivered.

export type CodemodeParseOutcome =
  | { kind: "script"; code: string; status?: string; prose?: string }
  | { kind: "multiple"; feedback: string }
  | { kind: "malformed"; feedback: string }
  | { kind: "none"; prose?: string };

/** A line that OPENS a codemode tag: `<codemode>` or `<codemode status="...">`
 * alone on its line. Line anchoring means a mid-line mention in prose ("use a
 * <codemode> tag") never opens anything — the same lesson the platform's
 * fenced format learned from a production incident with ``` in string
 * literals. */
const OPEN_LINE_RE = /^[ \t]*<codemode(\s[^>]*)?>[ \t]*$/;
const CLOSE_LINE_RE = /^[ \t]*<\/codemode>[ \t]*$/;
const STATUS_ATTR_RE = /\bstatus="([^"]*)"/;

/** A body that is already a complete async function and must not be wrapped. */
const ASYNC_FUNCTION_BODY_RE = /^(?:async\s*(?:function|\()|\(?async\s*\()/;

const GRAMMAR_REMINDER =
  'Format reminder — `<codemode status="...">` on its own line, TypeScript statements (top-level `await`/`return` allowed), then `</codemode>` on its own line. Markdown outside the tag is sent to the user; the status attribute is shown while the code runs.';

export function parseCodemodeResponse(content: string): CodemodeParseOutcome {
  const lines = content.split("\n");
  const openIndexes = lines.flatMap((line, index) => (OPEN_LINE_RE.test(line) ? [index] : []));
  const closeIndexes = lines.flatMap((line, index) => (CLOSE_LINE_RE.test(line) ? [index] : []));
  if (openIndexes.length === 0) {
    if (closeIndexes.length > 0) {
      return {
        kind: "malformed",
        feedback: `Your code did NOT run: the response has a </codemode> line with no opening <codemode> line before it. ${GRAMMAR_REMINDER}`,
      };
    }
    // No tag at all: a deliberate no-op turn — but the prose still reaches
    // the user, which is exactly how this format ends a conversation turn.
    const prose = content.trim();
    return prose === "" ? { kind: "none" } : { kind: "none", prose };
  }
  if (openIndexes.length > 1) {
    return {
      kind: "multiple",
      feedback: `Your response contained ${openIndexes.length} <codemode> tags, so NOTHING was executed. Use at most ONE <codemode> tag per turn — your script's return value arrives as your next input and you write the next step then. Resend just the FIRST step as a single tag.`,
    };
  }
  const openIndex = openIndexes[0];
  // The body ends at the LAST closing line after the opener: a raw
  // `</codemode>` line CAN appear inside a template literal the script
  // builds, and cutting there would execute an unparseable prefix.
  const closersAfterOpen = closeIndexes.filter((index) => index > openIndex);
  if (closeIndexes.some((index) => index < openIndex) || closersAfterOpen.length === 0) {
    return {
      kind: "malformed",
      feedback: `Your code did NOT run: the <codemode> tag was never closed (or a stray </codemode> line appeared before it). ${GRAMMAR_REMINDER}`,
    };
  }
  const closeIndex = closersAfterOpen[closersAfterOpen.length - 1];
  const body = lines
    .slice(openIndex + 1, closeIndex)
    .join("\n")
    .trim();
  if (body === "") {
    return {
      kind: "malformed",
      feedback: `Your code did NOT run: the <codemode> tag was empty. ${GRAMMAR_REMINDER}`,
    };
  }
  const statusMatch = lines[openIndex].match(STATUS_ATTR_RE);
  const status = (!statusMatch ? "" : statusMatch[1]).trim() || undefined;
  const beforeProse = lines.slice(0, openIndex).join("\n").trim();
  const afterProse = lines
    .slice(closeIndex + 1)
    .join("\n")
    .trim();
  const prose = [beforeProse, afterProse].filter((part) => part !== "").join("\n\n");
  return {
    kind: "script",
    // Bare statements (the normal case: top-level await/return) get the
    // standard codemode envelope; a body that is already a complete async
    // function passes through untouched.
    code: ASYNC_FUNCTION_BODY_RE.test(body) ? body : `async (itx) => {\n${body}\n}`,
    ...(!status ? {} : { status }),
    ...(prose === "" ? {} : { prose }),
  };
}

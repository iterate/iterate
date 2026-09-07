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

export type CodemodePartialView = {
  /** Complete prose lines seen so far — safe to render as the streaming
   * message body. Never contains tag lines or script text. */
  prose: string;
  /** Present once an opening tag line has streamed. */
  script?: { code: string; status?: string; closed: boolean };
};

/**
 * Live-window classification of a PARTIALLY streamed response. Pure and
 * cumulative: call it with the full text so far on every delta — the format's
 * tags-sit-alone-on-their-own-line rule makes this a line walk with exactly
 * one ambiguity, the trailing partial line, which is withheld from prose
 * while it could still become an opening tag.
 *
 * Deliberate divergences from the settled parse (`parseCodemodeResponse` is
 * the durable truth at settlement; this is cosmetic):
 * - the FIRST closing line ends the script (the last-closer rule needs the
 *   whole response — a template literal containing `</codemode>` may show a
 *   briefly shorter script live);
 * - a second opening tag streams as prose (the settled parse rejects the
 *   whole response as `multiple`, with feedback).
 */
export function parseCodemodePartial(content: string): CodemodePartialView {
  const lines = content.split("\n");
  // The final element never ends in "\n": it is a partial line (possibly "").
  const partialLine = lines.pop() as string; // split() always yields >= 1 element
  // Prose accrues in two segments around the tag, trimmed and joined exactly
  // like the settled parse so the streamed text converges byte-for-byte.
  const beforeLines: string[] = [];
  const afterLines: string[] = [];
  let script: { code: string; status?: string; closed: boolean } | undefined;
  const codeLines: string[] = [];
  for (const line of lines) {
    if (script !== undefined && !script.closed) {
      if (CLOSE_LINE_RE.test(line)) {
        script.closed = true;
      } else {
        codeLines.push(line);
      }
      continue;
    }
    if (script === undefined && OPEN_LINE_RE.test(line)) {
      const statusMatch = line.match(STATUS_ATTR_RE);
      const status = (statusMatch === null ? "" : statusMatch[1]).trim() || undefined;
      script = { code: "", closed: false, ...(status === undefined ? {} : { status }) };
      continue;
    }
    (script === undefined ? beforeLines : afterLines).push(line);
  }
  if (script !== undefined && !script.closed) {
    // Same ambiguity as the prose side, mirrored: a partial line that could
    // still become the closing tag is withheld so `</codemode>` never
    // flashes inside the streamed script.
    if (partialLine !== "" && !mightBecomeTagLine(partialLine, "</codemode>")) {
      codeLines.push(partialLine);
    }
  } else if (!mightBecomeTagLine(partialLine, "<codemode")) {
    (script === undefined ? beforeLines : afterLines).push(partialLine);
  }
  if (script !== undefined) script.code = codeLines.join("\n");
  const prose = [beforeLines.join("\n").trim(), afterLines.join("\n").trim()]
    .filter((part) => part !== "")
    .join("\n\n");
  return {
    prose,
    ...(script === undefined ? {} : { script }),
  };
}

/** Is this trailing partial line a prefix of a possible tag line (`tagStart`
 * = `"<codemode"` for openers, `"</codemode>"` for closers)? If so it is
 * withheld from the streaming view so tag syntax never flashes as content
 * mid-stream. */
function mightBecomeTagLine(partialLine: string, tagStart: string): boolean {
  const stripped = partialLine.replace(/^[ \t]*/, "");
  if (stripped === "") return false;
  return stripped.length <= tagStart.length
    ? tagStart.startsWith(stripped)
    : stripped.startsWith(tagStart);
}

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
  const status = (statusMatch === null ? "" : statusMatch[1]).trim() || undefined;
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
    ...(status === undefined ? {} : { status }),
    ...(prose === "" ? {} : { prose }),
  };
}

// The waiter response format: parses one front-of-house assistant response
// into diner-visible prose, kitchen orders, and an optional peek request.
//
// Inspired by configs/codemode-tag/codemode-format.ts (iterate/iterate), which
// is itself vendored from the platform's response-format module. Modifications
// from that original: the tag is <kitchen> (relayed text, not executable
// code), a same-line close is allowed (orders are conversational one-liners,
// not code blocks), multiple orders per response are permitted, and a <peek/>
// tag is added. The line-anchored OPENER rule is kept: a mid-line mention in
// prose ("use a <kitchen> tag") never opens anything.
//
// The grammar this parses:
//
//   One moment — sending that to the kitchen now!
//
//   <kitchen>The diner wants a multiplayer Subbuteo-like game…</kitchen>
//   <peek/>

export type WaiterParseOutcome =
  | { kind: "ok"; prose?: string; orders: string[]; peek: boolean }
  | { kind: "malformed"; feedback: string };

/** A line that OPENS a kitchen order: `<kitchen>` at the start of a line
 * (leading whitespace allowed). The order may close on the same line or a
 * later one. */
const KITCHEN_OPEN_RE = /^[ \t]*<kitchen>/;
const KITCHEN_CLOSE = "</kitchen>";
/** `<peek/>` (or `<peek />` / `<peek></peek>`) alone on its line. */
const PEEK_LINE_RE = /^[ \t]*<peek\s*\/?>(<\/peek>)?[ \t]*$/;

const GRAMMAR_REMINDER =
  "Format reminder — start `<kitchen>` at the beginning of a line and close it with `</kitchen>` (same line or a later one). `<peek/>` goes alone on its own line. Everything outside tags is shown to the diner.";

export function parseWaiterResponse(content: string): WaiterParseOutcome {
  const lines = content.split("\n");
  const proseLines: string[] = [];
  const orders: string[] = [];
  let peek = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (PEEK_LINE_RE.test(line)) {
      peek = true;
      continue;
    }
    if (!KITCHEN_OPEN_RE.test(line)) {
      if (line.includes(KITCHEN_CLOSE)) {
        return {
          kind: "malformed",
          feedback: `Your message was NOT delivered: a stray ${KITCHEN_CLOSE} appeared with no order open. ${GRAMMAR_REMINDER}`,
        };
      }
      proseLines.push(line);
      continue;
    }
    // Collect the order body from the opener line to the first closing tag.
    const afterOpen = line.slice(line.indexOf(">") + 1);
    const bodyParts: string[] = [];
    let closed = false;
    let cursor = afterOpen;
    while (true) {
      const closeAt = cursor.indexOf(KITCHEN_CLOSE);
      if (closeAt !== -1) {
        bodyParts.push(cursor.slice(0, closeAt));
        const trailing = cursor.slice(closeAt + KITCHEN_CLOSE.length).trim();
        if (trailing !== "") proseLines.push(trailing);
        closed = true;
        break;
      }
      bodyParts.push(cursor);
      index++;
      if (index >= lines.length) break;
      cursor = lines[index];
    }
    if (!closed) {
      return {
        kind: "malformed",
        feedback: `Your message was NOT delivered: a <kitchen> order was never closed. ${GRAMMAR_REMINDER}`,
      };
    }
    const body = bodyParts.join("\n").trim();
    if (body === "") {
      return {
        kind: "malformed",
        feedback: `Your message was NOT delivered: the <kitchen> order was empty. ${GRAMMAR_REMINDER}`,
      };
    }
    orders.push(body);
  }

  const prose = proseLines.join("\n").trim();
  return { kind: "ok", ...(prose === "" ? {} : { prose }), orders, peek };
}

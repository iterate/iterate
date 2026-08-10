// Response formats: the strategies that decide what a raw assistant response
// MEANS — which part is an executable codemode script, and what feedback to
// send when the response breaks its format's contract. Split out of
// agent-processor-implementation.ts so the format is swappable per agent
// without touching orchestration: the processor picks a format, hands it the
// accepted assistant text, and maps the returned outcome to appends (script
// request, corrective developer feedback). PURE and transport-free: no
// StreamProcessor, no stream reads, no clocks — off-runtime readers (UI
// bundles) may import this.

/**
 * What one assistant response means, as decided by a response format.
 *
 * - `script`: run `code` through the capability host. `status` (a
 *   format-provided activity label) and `prose` (user-visible text riding
 *   outside the code) are optional extras a richer format may extract; the
 *   fenced-ts format never produces them.
 * - `multiple`: the model queued several scripts in one response (planning
 *   ahead). Executing only the first and dropping the rest silently is the
 *   worst option — the model believes everything it wrote will run — so the
 *   caller rejects the whole output with the format's corrective feedback.
 * - `malformed`: the response attempted the format but nothing runnable came
 *   out of it. Nothing can run; the caller sends the corrective feedback
 *   (silence here reads as the platform hanging).
 * - `none`: no code at all — a deliberate no-op turn ending the loop. `prose`
 *   carries any user-visible text a richer format wants delivered anyway.
 */
export type ResponseParseOutcome =
  | { kind: "script"; code: string; status?: string; prose?: string }
  | { kind: "multiple"; feedback: string }
  | { kind: "malformed"; feedback: string }
  | { kind: "none"; prose?: string };

/**
 * One way of interpreting assistant output. `id` is opaque here — the only
 * place format names are enumerated is the processor contract's config knob,
 * so this module never learns which formats exist.
 */
export type AgentResponseFormat = {
  id: string;
  parse: (content: string) => ResponseParseOutcome;
};

// -----------------------------------------------------------------------------
// fenced-ts: the original codemode format. Exactly one ```ts fence whose body
// is a single leading-`async` function; prose outside the fence is discarded.
// -----------------------------------------------------------------------------

const FENCED_SNIPPET_RE = /^[ \t]*```(?:ts|typescript)?[ \t]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/im;
const ANY_FENCED_BLOCK_RE = /^[ \t]*```[^\n]*\n[\s\S]*?\n[ \t]*```[ \t]*$/gim;

export const fencedTsResponseFormat: AgentResponseFormat = {
  id: "fenced-ts",
  parse: (content) => {
    // Fences count only at line starts: scripts legitimately carry ``` inside
    // string literals (chat messages formatted as markdown), and in valid
    // TypeScript those always sit mid-line — a raw newline cannot appear in a
    // string literal, and an unescaped ``` would terminate a template literal.
    // A fence match anywhere used to cut the script at the first embedded ```
    // and execute an unparseable prefix (unclosed string literal). Count every
    // fenced block before validating its language tag: a mixed response (one
    // runnable TypeScript block plus another fenced block) must reject the
    // whole output instead of executing the first and silently dropping the
    // rest.
    const blocks = content.match(ANY_FENCED_BLOCK_RE) ?? [];
    if (blocks.length > 1) {
      return {
        kind: "multiple",
        feedback: `Your response contained ${blocks.length} fenced code blocks, so NOTHING was executed. Respond with exactly ONE fenced code block per turn. Do not queue future steps as extra blocks — your script's return value arrives as your next input and you write the next step then. Resend just the FIRST step as a single \`\`\`ts block.`,
      };
    }
    const fenced = content.match(FENCED_SNIPPET_RE);
    const code = (fenced?.[1] ?? content).trim();
    if (/^async\s*(?:function|\()/.test(code) || /^\(?async\s*\(/.test(code)) {
      return { kind: "script", code };
    }
    // Any response carrying a line-start fence that did not yield a runnable
    // script is a malformed attempt — including fences with a non-TypeScript
    // language tag, which FENCED_SNIPPET_RE refuses to match (models
    // habitually open code with a comment line). Only a fence-free non-script
    // response is a deliberate no-op turn; the system prompt promises
    // rejection-with-feedback for everything else.
    return fenced !== null || /^[ \t]*```/m.test(content)
      ? {
          kind: "malformed",
          feedback:
            "Your code block did NOT run. Use a ```ts fence whose content STARTS with `async` — a single `async (itx) => { ... }`, TypeScript only, no comments or statements before the function. Resend it as one such block (move any leading comments inside the function body).",
        }
      : { kind: "none" };
  },
};

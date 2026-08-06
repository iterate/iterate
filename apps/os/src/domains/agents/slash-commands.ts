// Chat slash commands: deterministic actions typed into ANY chat surface.
//
// Every surface (web, Slack, mobile) delivers user messages through the one
// inbound door — `agents/context-added` with role "user" — so this module is
// consulted exactly there, server-side in the agent processor: a message
// that RESOLVES to a command runs as a codemode script with the agent's own
// provenance instead of triggering an LLM turn (the command stays visible in
// the thread as an ordinary user message; `/script` appends its result as
// interruptive developer context and drives the agent's next turn).
//
// Anything that does NOT resolve — an unknown `/command`, a bad example
// slug, malformed vars — deliberately falls through to the LLM untouched:
// people legitimately type paths and fractions, and the model gracefully
// explains a typo'd slug where a hard error would dead-end the thread.

import { z } from "zod";
import { ITX_EXAMPLES, runScriptEnvelope } from "../../itx/examples.ts";

/** `/example` vars must be a plain JSON object of overrides — arrays,
 * primitives, and null fall through to the LLM like any other non-command. */
const ExampleVars = z.record(z.string(), z.unknown());

type ResolvedSlashCommand =
  | {
      /** Which command matched — recorded on nothing, useful for tests/logs. */
      command: "example";
      /** The exact `async (itx) => …` source handed to the run-script door. */
      code: string;
    }
  | {
      command: "script";
      /** The user-authored body, normalized to return a single expression. */
      body: string;
    };

/**
 * Resolve a user message into a runnable slash command, or null. PURE and
 * deterministic (the examples catalogue is a static import): the reduce's
 * trigger derivation calls this on the same payload the processor's event
 * handler does, and both must agree forever.
 */
export function resolveSlashCommand(content: string): ResolvedSlashCommand | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) return null;

  const exampleMatch = trimmed.match(/^\/example\s+([a-z0-9-]+)\s*([\s\S]*)$/);
  if (exampleMatch) {
    const [, slug, rest] = exampleMatch;
    // Only entries that genuinely run through the run-script door qualify:
    // session-context examples (whoami via the OS Session) have no itx here,
    // and non-run-script runtimes would silently do nothing. Agent-context
    // entries DO qualify — a chat thread is exactly the live conversation
    // they need. Everything else falls through to the LLM like a typo.
    const example = ITX_EXAMPLES.find(
      (entry) =>
        entry.id === slug && entry.context !== "session" && entry.runtimes.includes("run-script"),
    );
    if (!example) return null;
    let vars: Record<string, unknown> = {};
    if (rest!.trim() !== "") {
      try {
        const parsed = ExampleVars.safeParse(JSON.parse(rest!.trim()));
        if (!parsed.success) return null;
        vars = parsed.data;
      } catch {
        return null;
      }
    }
    return { command: "example", code: runScriptEnvelope(example.code, vars) };
  }

  const scriptMatch = trimmed.match(/^\/script\s+([\s\S]+)$/);
  if (scriptMatch) {
    let code = scriptMatch[1]!.trim();
    // Allow (and strip) a markdown fence — chat surfaces love wrapping code.
    const fenced = code.match(/^```(?:ts|typescript|js|javascript)?\s*\n([\s\S]*?)\n?```$/);
    if (fenced) code = fenced[1]!.trim();
    if (code === "") return null;
    // A single expression gets an implicit `return` so `/script await
    // itx.whatever()` answers with the value; anything statement-shaped
    // (semicolons, braces, multiple lines, statement keywords — anything
    // where `return (...)` would be wrong or invalid) runs verbatim and
    // returns whatever it explicitly returns.
    const singleExpression =
      !code.includes("\n") &&
      !code.includes(";") &&
      !/^(const|let|var|return|if|for|while|throw|try|switch|do)\b/.test(code);
    // Closing paren on its OWN line: a trailing `// note` on the expression
    // must not comment it out (and `//` inside a URL string makes detecting
    // comments non-trivial, so the newline handles every case).
    const body = singleExpression ? `return (${code}\n);` : code;
    return { command: "script", body };
  }

  return null;
}

/** Build the event-specific script source after the command's execution ID is
 * known. `/script` publishes successful results itself; its settlement stays
 * reserved for failures and the no-result completion fact. */
export function buildSlashCommandCode(command: ResolvedSlashCommand, executionId: string): string {
  if (command.command === "example") return command.code;

  const actor = JSON.stringify({ type: "script", executionId });
  const idempotencyKey = JSON.stringify(`agent/slash-command-result@${executionId}`);
  return `async (itx) => {
const agent = itx.agent;
if (!agent) throw new Error("/script requires an agent-scoped itx");
const result = await (async () => {
${command.body}
})();
if (result === undefined) return;
let content;
if (typeof result === "string") {
  content = result;
} else {
  try {
    content = JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    content = String(result);
  }
}
await agent.append({
  type: "events.iterate.com/agents/context-added",
  payload: {
    role: "developer",
    content,
    actor: ${actor},
    llmRequestPolicy: { behaviour: "interrupt-current-request" },
  },
  idempotencyKey: ${idempotencyKey},
});
}`;
}

/** The executionId prefix for slash-command runs — sibling of the
 * agent-authored `agent-output:` prefix, keyed by the commanding user
 * message's offset. */
export const SLASH_COMMAND_EXECUTION_PREFIX = "slash-command:";

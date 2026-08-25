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
      /** The normalized command text shown alongside its result. */
      invocation: string;
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
    // A single expression gets an implicit `return await`, so `/script
    // itx.whatever()` and `/script await itx.whatever()` behave identically;
    // anything statement-shaped
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
    const expression = code.replace(/^await\s+/, "");
    const body = singleExpression ? `return await (${expression}\n);` : code;
    return { command: "script", invocation: `/script ${code}`, body };
  }

  return null;
}

/** Build the event-specific script source after the command's execution ID is
 * known. `/script` publishes successful results itself and still returns the
 * value so the capability host can retain it in the script-results preamble. */
export function buildSlashCommandCode(command: ResolvedSlashCommand, executionId: string): string {
  if (command.command === "example") return command.code;

  const actor = JSON.stringify({ type: "script", executionId });
  const idempotencyKey = JSON.stringify(`agent/slash-command-result@${executionId}`);
  const resultPrefix = JSON.stringify(
    `User ran \`${command.invocation}\` command with the following result:\n\n`,
  );
  return `async (itx) => {
const result = await (async () => {
${command.body}
})();
if (result === undefined) return result;
if (!itx.agent) throw new Error("/script requires an agent-scoped itx");
await itx.agent.append({
  type: "events.iterate.com/agents/context-added",
  payload: {
    content: ${resultPrefix} + (typeof result === "string" ? result : JSON.stringify(result, null, 2)),
    actor: ${actor},
    llmRequestPolicy: { behaviour: "interrupt-current-request" },
  },
  idempotencyKey: ${idempotencyKey},
});
return result;
}`;
}

/** The executionId prefix for slash-command runs — sibling of the
 * agent-authored `agent-output:` prefix, keyed by the commanding user
 * message's offset. */
export const SLASH_COMMAND_EXECUTION_PREFIX = "slash-command:";
export const SCRIPT_SLASH_COMMAND_EXECUTION_PREFIX = `${SLASH_COMMAND_EXECUTION_PREFIX}script:`;

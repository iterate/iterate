// Chat slash commands: deterministic actions typed into ANY chat surface.
//
// Every surface (web, Slack, mobile) delivers user messages through the one
// inbound door — `agents/context-added` with role "user" — so this module is
// consulted exactly there, server-side in the agent processor: a message
// that RESOLVES to a command runs as a codemode script with the agent's own
// provenance instead of triggering an LLM turn (the command stays visible in
// the thread as an ordinary user message).
//
// Anything that does NOT resolve — an unknown `/command`, a bad example
// slug, malformed vars — deliberately falls through to the LLM untouched:
// people legitimately type paths and fractions, and the model gracefully
// explains a typo'd slug where a hard error would dead-end the thread.
//
// There used to be a `/script <code>` command here (run arbitrary user
// TypeScript as a side-band action). It was removed in favor of the two
// surfaces that do its jobs better: operators run
// `itx.agents.get(path).capabilityHost.runScript(...)` from the REPL/CLI, and
// tests script whole conversations through the fake/* model lane
// (`itx.ai.intercept`).

import { z } from "zod";
import { ITX_EXAMPLES, runScriptEnvelope } from "../../itx/examples.ts";

/** `/example` vars must be a plain JSON object of overrides — arrays,
 * primitives, and null fall through to the LLM like any other non-command. */
const ExampleVars = z.record(z.string(), z.unknown());

type ResolvedSlashCommand = {
  /** Which command matched — recorded on nothing, useful for tests/logs. */
  command: "example";
  /** The exact `async (itx) => …` source handed to the run-script door. */
  code: string;
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

  return null;
}

/** The executionId prefix for slash-command runs — sibling of the
 * agent-authored `agent-output:` prefix, keyed by the commanding user
 * message's offset. */
export const SLASH_COMMAND_EXECUTION_PREFIX = "slash-command:";

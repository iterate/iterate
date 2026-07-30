// Chat slash commands: deterministic actions typed into ANY chat surface.
//
// Every surface (web, Slack, mobile) delivers user messages through the one
// inbound door — `agents/context-added` with role "user" — so this module is
// consulted exactly there, server-side in the agent processor: a message
// that RESOLVES to a command runs as a codemode script with the agent's own
// provenance instead of triggering an LLM turn (the command stays visible in
// the thread as an ordinary user message; the script result renders back as
// developer context and drives the agent's next turn, which is when the
// working indicator finally clears — the same lifecycle an agent-authored
// script has).
//
// Anything that does NOT resolve — an unknown `/command`, a bad example
// slug, malformed vars — deliberately falls through to the LLM untouched:
// people legitimately type paths and fractions, and the model gracefully
// explains a typo'd slug where a hard error would dead-end the thread.

import { z } from "zod";
import { ITX_EXAMPLES, runScriptEnvelope } from "../../itx/examples.ts";

/** `/example` vars must be a plain JSON object of overrides — arrays,
 * primitives, and null fall through to the LLM like any other non-command. */
const exampleVarsSchema = z.record(z.string(), z.unknown());

type ResolvedSlashCommand = {
  /** Which command matched — recorded on nothing, useful for tests/logs. */
  command: "example" | "script";
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
    const example = ITX_EXAMPLES.find((entry) => entry.id === slug);
    if (!example) return null;
    let vars: Record<string, unknown> = {};
    if (rest!.trim() !== "") {
      try {
        const parsed = exampleVarsSchema.safeParse(JSON.parse(rest!.trim()));
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
    const body = singleExpression ? `return (${code});` : code;
    return { command: "script", code: `async (itx) => {\n${body}\n}` };
  }

  return null;
}

/** The executionId prefix for slash-command runs — sibling of the
 * agent-authored `agent-output:` prefix, keyed by the commanding user
 * message's offset. */
export const SLASH_COMMAND_EXECUTION_PREFIX = "slash-command:";

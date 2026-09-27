// e2e/fixtures.ts — the agent stories' shared fixtures (agents*.e2e.test.ts): the model a story
// configures, the operator's prompt, the log readers and a 1×1 PNG. The model itself is the one fake
// `itx.ai` (../../os/e2e/support/fake-ai.ts).
import { readAll, until } from "../../os/e2e/support/client.ts";

export const short = (log: { type: string }[]) =>
  log
    .filter((e) => /^events\.iterate\.com\/(agent\/|itx\/run-)/.test(e.type))
    .map((e) => e.type.replace("events.iterate.com/", ""));
/** The default model is OpenAI's astra; a local story pins Workers AI so the fake `itx.ai` answers. */
export const WORKERS_AI_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
/** Configure the agent's model: Workers AI by default, or a partner model by name. */
export const configureModel = (
  support: { append: (event: unknown) => Promise<unknown> },
  model = WORKERS_AI_MODEL,
) =>
  support.append({
    type: "events.iterate.com/agent/configured",
    payload: { config: { llm: { model } } },
  });

/** The operator's instructions, their own keyed system item after the birth. */
export const operatorPrompt = (agent: { append: (event: unknown) => Promise<unknown> }) =>
  agent.append({
    type: "events.iterate.com/agent/context-added",
    payload: { role: "system", content: "Be terse." },
    idempotencyKey: "operator-prompt:v1",
  });

/** The context's log once a request has settled. */
export const settledLog = (context: unknown, label: string) =>
  until(label, async () => {
    const all = await readAll(context);
    return all.some((event) => event.type === "events.iterate.com/agent/llm-request-settled")
      ? all
      : undefined;
  });

export const assistantWords = (log: { type: string; payload?: unknown }[]) =>
  log
    .filter((e) => e.type === "events.iterate.com/agent/context-added")
    .map((e) => e.payload as { role: string; content: string })
    .filter((p) => p.role === "assistant")
    .map((p) => p.content);

/** The AI Gateway's refusal once a spend limit rule has used its budget: HTTP 429, code 2045,
 *  "Spend limit exceeded: rule '<id>' (cost limit … per …s, sliding)". */
const SPEND_CAP = /\b2045\b|spend limit exceeded/i;

/** The context's log once the assistant has answered. It fails at once, never at the two-minute
 *  bound, when the answer cannot come: a request refused by the AI Gateway's spend cap fails naming
 *  the cap (no retry inside a row outlasts a 24-hour window, and a spent budget must not read as a
 *  flake: 2026-09-24), and an agent that paused (the model refused every attempt) fails with the last
 *  refusal. A timeout names the last failed request. */
export async function answeredLog(context: unknown, label: string): Promise<any[]> {
  let lastFailure: string | undefined;
  const outcome = await until(
    label,
    async () => {
      const log = await readAll(context);
      if (assistantWords(log).length > 0) return { log };
      const failures = log
        .filter((e) => e.type === "events.iterate.com/agent/llm-request-settled")
        .map((e) => e.payload.result)
        .filter((result) => result.status === "failed")
        .map((result): string => result.errorMessage);
      lastFailure = failures.at(-1) ?? lastFailure;
      const capped = failures.find((message) => SPEND_CAP.test(message));
      if (capped) return { capped };
      const paused = log.find((e) => e.type === "events.iterate.com/agent/paused");
      return paused ? { paused: String(paused.payload.reason) } : undefined;
    },
    120_000,
  ).catch((error: unknown) => {
    const timedOut = error instanceof Error ? error.message : String(error);
    throw new Error(
      lastFailure ? `${timedOut}; the last failed request: ${lastFailure}` : timedOut,
    );
  });
  if ("capped" in outcome)
    throw new Error(
      `the AI Gateway's spend cap refused the model request, so this row cannot pass until the cap's window frees budget or its limit is raised (docs/testing.md#real-model-rows): ${outcome.capped}`,
    );
  if ("paused" in outcome)
    throw new Error(
      `the agent paused without answering (${outcome.paused}); the model's last refusal: ${lastFailure || "none"}`,
    );
  return outcome.log;
}

export const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR42mP4z8AARAwQCgAf7gP9Y167WwAAAABJRU5ErkJggg==";

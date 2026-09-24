/**
 * One backend turn for a delegation the live voice model raised: a chat model
 * over the words so far, with ONE tool (a TypeScript script against `itx`),
 * ending in the sentence the voice should say. Pure: the model call and the
 * script runner come in as functions, so this is table-tested in node.
 */
import { parseCodemodeResponse } from "../runtime/codemode-format.ts";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "../runtime/system-prompt.ts";

// A website edit needs discovery, a candidate probe, publication and a live check;
// the production recovery case alone took seven scripts. Allow bounded recovery
// across those phases, then reserve the final model call for an honest summary.
const MAX_SCRIPT_STEPS = 24;
const HANG_UP_TOKEN = "HANG_UP";

const DELEGATION_SYSTEM_PROMPT = [
  DEFAULT_AGENT_SYSTEM_PROMPT,
  "INSTRUCTIONS FOR SPOKEN CONVERSATIONS:",
  "You are the backend of a spoken assistant on the Iterate platform. A live voice model talks to the person and hands you the requests it cannot answer itself; you answer in writing and the voice reads your answer aloud.",
  "Keep prose outside codemode blocks suitable for speech: one to three short sentences, no markdown or preamble. Be exact about numbers and names. Report actions and failures only from the script results you have observed.",
  `You have at most ${MAX_SCRIPT_STEPS} script attempts for this request. Combine related reads when useful and leave room to verify changes. If blocked, explain the specific blocker and any changes already made.`,
  `If the person asked to end the call, answer with a short goodbye and end your reply with the token ${HANG_UP_TOKEN}.`,
].join("\n");

export type DelegationMessage = {
  role: "system" | "developer" | "user" | "assistant";
  content: string;
};

export type DelegationTurnDeps = {
  /** One chat turn: the conversation so far → the model's reply text. */
  complete(messages: DelegationMessage[]): Promise<string>;
  /** Run `async (itx) => …`; the JSON of what it returned, or the error text. */
  runScript(script: string): Promise<string>;
  /** Preserve tool calls and results as ordinary conversation context for later requests. */
  remember?(messages: DelegationMessage[]): Promise<unknown>;
  /** A progress note the voice may use quietly, once per script step. */
  progress(note: string): Promise<unknown>;
};

/** Run the turn to its spoken answer. Never throws: a failure is spoken too. */
export async function runDelegationTurn(
  transcript: { role: "listener" | "assistant"; text: string }[],
  deps: DelegationTurnDeps,
  context: DelegationMessage[] = [],
): Promise<{ content: string; hangUp: boolean; scripts: number }> {
  let scripts = 0;
  let answer = "";
  try {
    const messages: DelegationMessage[] = [
      {
        role: "system",
        content: DELEGATION_SYSTEM_PROMPT,
      },
      ...context,
      ...transcript.map((turn) => ({
        role: turn.role === "listener" ? ("user" as const) : ("assistant" as const),
        content: turn.text,
      })),
    ];
    for (let step = 0; step <= MAX_SCRIPT_STEPS; step += 1) {
      if (step === MAX_SCRIPT_STEPS) {
        messages.push({
          role: "system",
          content:
            "No script attempts remain. Respond without a codemode block. Explain what the observed results show was completed, what remains unverified or blocked, and the next action needed. Do not claim success for an unverified change.",
        });
      }
      const reply = await deps.complete(messages);
      const parsed = parseCodemodeResponse(reply);
      if (parsed.kind === "none") {
        answer = parsed.prose || "";
        break;
      }
      if (step === MAX_SCRIPT_STEPS) {
        answer = "I couldn't finish the request within the allowed number of steps.";
        break;
      }
      messages.push({ role: "assistant", content: reply });
      if (parsed.kind === "malformed" || parsed.kind === "multiple") {
        messages.push({ role: "user", content: parsed.feedback });
        continue;
      }
      scripts += 1;
      // Prose beside a tool call can speculate about an outcome the script has not produced yet.
      // Only its activity label is progress; the spoken answer comes after observing the result.
      await deps.progress(parsed.status || "Running a script for your request.");
      const result: DelegationMessage = {
        role: "user",
        content: `Script result:\n${await deps.runScript(parsed.code)}`,
      };
      await deps.remember?.([{ role: "assistant", content: reply }, result]);
      messages.push(result);
    }
  } catch (error) {
    answer = `Sorry, that did not work: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`;
  }
  const hangUp = answer.includes(HANG_UP_TOKEN);
  return { content: answer.replace(HANG_UP_TOKEN, "").trim() || "Done.", hangUp, scripts };
}

/** OpenAI's Responses API, dialled through this context's egress with the project secret. */
export async function completeWithOpenAi(messages: DelegationMessage[]): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: 'Bearer getSecret("/secrets/openai")',
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-6-astra",
      reasoning: { effort: "low" },
      service_tier: "priority",
      input: messages.map((message) => ({
        role: message.role === "system" ? "developer" : message.role,
        content: message.content,
      })),
    }),
  });
  if (!response.ok) {
    throw new Error(`model ${String(response.status)}: ${(await response.text()).slice(0, 300)}`);
  }
  const body = (await response.json()) as {
    output?: { type?: string; content?: { type?: string; text?: string }[] }[];
  };
  const text = (body.output || [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text || "")
    .join("\n")
    .trim();
  if (text === "") throw new Error("the model answered with no text");
  return text;
}

/**
 * One backend turn for a delegation the live voice model raised: a chat model
 * over the words so far, with ONE tool (a TypeScript script against `itx`),
 * ending in the sentence the voice should say. Pure: the model call and the
 * script runner come in as functions, so this is table-tested in node.
 */

const MAX_SCRIPT_STEPS = 6;
const HANG_UP_TOKEN = "HANG_UP";

export const DELEGATION_SYSTEM_PROMPT = [
  "You are the backend of a spoken assistant on the Iterate platform. A live voice model talks to the person and hands you the requests it cannot answer itself; you answer in writing and the voice reads your answer aloud.",
  "You have ONE tool: a TypeScript script. To run one, reply with exactly one fenced block:",
  "```ts",
  "async (itx) => { … return value }",
  "```",
  "The script runs in this conversation's context and its return value (JSON) comes back to you as the next input. `itx` offers: `whoami()`, `kv.get/put/list`, `repos.readFile(repo, path)` / `repos.writeFile(repo, path, text)`, `secrets.list()`, `cd(path)` (a sibling context: `append`, `readEvents(after, limit)`), `fetch(url, init)` (the internet, through the project's egress), `readEvents(after, limit)` (this conversation's log). Prefer one script that does the whole job.",
  "When you do not need a script (or have the result), reply with the SPOKEN ANSWER ONLY: one to three short sentences a voice can read, no markdown, no code, no preamble. Be exact about numbers and names.",
  `If the person asked to end the call, answer with a short goodbye and end your reply with the token ${HANG_UP_TOKEN}.`,
].join("\n");

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type DelegationTurnDeps = {
  /** One chat turn: the conversation so far → the model's reply text. */
  complete(messages: ChatMessage[]): Promise<string>;
  /** Run `async (itx) => …`; the JSON of what it returned, or the error text. */
  runScript(script: string): Promise<string>;
  /** A progress note the voice may use quietly, once per script step. */
  progress(note: string): Promise<unknown>;
};

/** The one fenced ```ts block of a reply, or null when the reply is the spoken answer. */
export function scriptOf(reply: string): string | null {
  const match = /```(?:ts|typescript|js|javascript)?\s*\n([\s\S]*?)```/.exec(reply);
  return match ? match[1]!.trim() : null;
}

/** Run the turn to its spoken answer. Never throws: a failure is spoken too. */
export async function runDelegationTurn(
  transcript: { role: "listener" | "assistant"; text: string }[],
  deps: DelegationTurnDeps,
): Promise<{ content: string; hangUp: boolean; scripts: number }> {
  let scripts = 0;
  let answer = "";
  try {
    const messages: ChatMessage[] = [
      { role: "system", content: DELEGATION_SYSTEM_PROMPT },
      ...transcript.map((turn) => ({
        role: turn.role === "listener" ? ("user" as const) : ("assistant" as const),
        content: turn.text,
      })),
    ];
    for (let step = 0; step <= MAX_SCRIPT_STEPS; step += 1) {
      const reply = await deps.complete(messages);
      const script = scriptOf(reply);
      if (!script || step === MAX_SCRIPT_STEPS) {
        answer = reply.replace(/```[\s\S]*?```/g, "").trim();
        break;
      }
      scripts += 1;
      messages.push({ role: "assistant", content: reply });
      await deps.progress(`Backend step ${String(scripts)}: running a script for the request.`);
      messages.push({ role: "user", content: `Script result:\n${await deps.runScript(script)}` });
    }
  } catch (error) {
    answer = `Sorry, that did not work: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`;
  }
  const hangUp = answer.includes(HANG_UP_TOKEN);
  return { content: answer.replace(HANG_UP_TOKEN, "").trim() || "Done.", hangUp, scripts };
}

/** OpenAI's Responses API, dialled through this context's egress with the project secret. */
export async function completeWithOpenAi(messages: ChatMessage[]): Promise<string> {
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

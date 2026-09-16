/**
 * The voice call's backend: the ordinary agent the live model delegates to.
 *
 * GPT-Live raises a delegation when the person asks for something the voice
 * itself should not answer (a fact to look up, work to do). The voice facet
 * records it as `voice-agent/delegation-requested` with the words so far; this
 * processor runs one model turn over that transcript — a chat model with ONE
 * tool, a TypeScript script against this context's `itx` — and answers with
 * `voice-agent/commentary`, which the voice paraphrases aloud (and hangs up on
 * when asked). One durable `turn-settled` per delegation is the whole
 * lifecycle; an evicted attempt is re-run from the log because its settle
 * never landed.
 */
import {
  StreamProcessor,
  StreamProcessorDurableObject,
  defineProcessorContract,
  z,
  type ConsumedEvent,
  type ProcessEventArgs,
  type ReduceArgs,
} from "./processor.js";

const MAX_SCRIPT_STEPS = 6;
const MAX_SETTLED_REMEMBERED = 50;
const SCRIPT_RESULT_MAX_CHARS = 8_000;
const HANG_UP_TOKEN = "HANG_UP";

const SYSTEM_PROMPT = [
  "You are the backend of a spoken assistant on the Iterate platform. A live voice model talks to the person and hands you the requests it cannot answer itself; you answer in writing and the voice reads your answer aloud.",
  "You have ONE tool: a TypeScript script. To run one, reply with exactly one fenced block:",
  "```ts",
  "async (itx) => { … return value }",
  "```",
  "The script runs in this project's context and its return value (JSON) comes back to you as the next input. `itx` offers: `whoami()`, `kv.get/put/list`, `repos.readFile(repo, path)` / `repos.writeFile(repo, path, text)` / `repos.listFiles(repo)`, `secrets.list()`, `cd(path)` (a sibling context: `append`, `readEvents(after, limit)`), `fetch(url, init)` (the internet, through the project's egress), `readEvents(after, limit)` (this conversation's log). Prefer one script that does the whole job.",
  "When you do not need a script (or have the result), reply with the SPOKEN ANSWER ONLY: one to three short sentences a voice can read, no markdown, no code, no preamble. Be exact about numbers and names.",
  `If the person asked to end the call, answer with a short goodbye and end your reply with the token ${HANG_UP_TOKEN}.`,
].join("\n");

const VoiceBackendState = z.object({
  /** Delegations already answered, newest first — a redelivery is not a second answer. */
  settled: z.array(z.string()).max(MAX_SETTLED_REMEMBERED).default([]),
});
type VoiceBackendState = z.infer<typeof VoiceBackendState>;

const Transcript = z.array(z.object({ role: z.enum(["listener", "assistant"]), text: z.string() }));

export const VoiceBackendContract = defineProcessorContract({
  slug: "voice-backend",
  version: "1.0.0",
  description:
    "Answers the live voice model's delegations with one chat-model turn and a script tool, replying as voice-agent/commentary.",
  stateSchema: VoiceBackendState,
  events: {
    "events.iterate.com/voice-backend/turn-settled": {
      description: "One delegation was answered (or given up on), with what the model did.",
      payloadSchema: z.looseObject({
        activation: z.string(),
        delegationId: z.string(),
        status: z.enum(["answered", "failed"]),
        answer: z.string(),
        scripts: z.number(),
        elapsedMs: z.number(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/voice-agent/delegation-requested",
    "events.iterate.com/voice-backend/turn-settled",
  ],
  emits: [
    "events.iterate.com/voice-agent/commentary",
    "events.iterate.com/voice-agent/thinking",
    "events.iterate.com/voice-backend/turn-settled",
  ],
});
export type VoiceBackendContract = typeof VoiceBackendContract;

/** What the host injects: the model call and the script tool, both on this context's itx. */
export type VoiceBackendDeps = {
  /** One chat turn: the conversation so far → the model's reply text. */
  complete(messages: { role: "system" | "user" | "assistant"; content: string }[]): Promise<string>;
  /** Run `async (itx) => …` in this context; the JSON of what it returned, or the error text. */
  runScript(script: string): Promise<string>;
  nowMs(): number;
};

type Args = ProcessEventArgs<VoiceBackendState, ConsumedEvent<VoiceBackendContract>>;

/** The one fenced ```ts block of a reply, or null when the reply is the spoken answer. */
export function scriptOf(reply: string): string | null {
  const match = /```(?:ts|typescript|js|javascript)?\s*\n([\s\S]*?)```/.exec(reply);
  return match ? match[1]!.trim() : null;
}

export class VoiceBackendProcessor extends StreamProcessor<
  VoiceBackendState,
  ConsumedEvent<VoiceBackendContract>
> {
  readonly contract = VoiceBackendContract;

  constructor(private readonly deps: VoiceBackendDeps) {
    super();
  }

  /** Delegations this incarnation is answering right now, so a redelivered batch waits its turn. */
  readonly #inFlight = new Set<string>();

  reduce({ state, event }: ReduceArgs<VoiceBackendState, ConsumedEvent<VoiceBackendContract>>) {
    if (event.type !== "events.iterate.com/voice-backend/turn-settled") return state;
    const { delegationId } = event.payload;
    if (state.settled.includes(delegationId)) return state;
    return { settled: [delegationId, ...state.settled].slice(0, MAX_SETTLED_REMEMBERED) };
  }

  processEvent({ event, state, append, runInBackground }: Args): undefined {
    if (event?.type !== "events.iterate.com/voice-agent/delegation-requested") return;
    const request = z
      .object({
        activation: z.string(),
        conversationId: z.string(),
        delegationId: z.string(),
        transcript: Transcript,
      })
      .safeParse(event.payload);
    if (!request.success) return;
    const { activation, delegationId, transcript } = request.data;
    if (state.settled.includes(delegationId) || this.#inFlight.has(delegationId)) return;
    this.#inFlight.add(delegationId);

    runInBackground(async () => {
      const startedAtMs = this.deps.nowMs();
      let scripts = 0;
      let answer = "";
      let status: "answered" | "failed" = "answered";
      try {
        const messages: Parameters<VoiceBackendDeps["complete"]>[0] = [
          { role: "system", content: SYSTEM_PROMPT },
          ...transcript.map((turn) => ({
            role: turn.role === "listener" ? ("user" as const) : ("assistant" as const),
            content: turn.text,
          })),
        ];
        /* The words so far end with the person's request; the model answers it. */
        for (let step = 0; step <= MAX_SCRIPT_STEPS; step += 1) {
          const reply = await this.deps.complete(messages);
          const script = scriptOf(reply);
          if (!script || step === MAX_SCRIPT_STEPS) {
            answer = reply.replace(/```[\s\S]*?```/g, "").trim();
            break;
          }
          scripts += 1;
          messages.push({ role: "assistant", content: reply });
          await append({
            type: "events.iterate.com/voice-agent/thinking",
            idempotencyKey: this.idempotencyKey(`thinking:${delegationId}:${String(scripts)}`),
            payload: {
              activation,
              delegationId: null,
              content: `Backend step ${String(scripts)}: running a script for the request.`,
            },
          });
          const result = await this.deps.runScript(script);
          messages.push({ role: "user", content: `Script result:\n${result}` });
        }
      } catch (error) {
        status = "failed";
        answer = `Sorry, that did not work: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`;
      } finally {
        this.#inFlight.delete(delegationId);
      }
      const hangUp = answer.includes(HANG_UP_TOKEN);
      const spoken = answer.replace(HANG_UP_TOKEN, "").trim() || "Done.";
      await append(
        {
          type: "events.iterate.com/voice-agent/commentary",
          idempotencyKey: this.idempotencyKey(`commentary:${delegationId}`),
          payload: { activation, delegationId, content: spoken, ...(hangUp && { hangUp: true }) },
        },
        {
          type: "events.iterate.com/voice-backend/turn-settled",
          idempotencyKey: this.idempotencyKey(`settled:${delegationId}`),
          payload: {
            activation,
            delegationId,
            status,
            answer: spoken,
            scripts,
            elapsedMs: this.deps.nowMs() - startedAtMs,
          },
        },
      );
    });
  }
}

/* ========================================================================== */
/* HOST                                                                       */
/* ========================================================================== */

/** OpenAI's Responses API, dialled through this context's egress with the project secret. */
async function completeWithOpenAi(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
): Promise<string> {
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

/**
 * The facet os-next hosts beside the voice:
 *   itx.processors.enable("voice-backend", { source, className: "VoiceBackendDurableObject", consumes })
 */
export class VoiceBackendDurableObject extends StreamProcessorDurableObject<VoiceBackendState> {
  processor = new VoiceBackendProcessor({
    complete: completeWithOpenAi,
    runScript: async (script) => {
      const itx = this.env.ITX.get() as unknown as { run(script: string): Promise<unknown> };
      try {
        const value = await itx.run(script);
        return JSON.stringify(value ?? null).slice(0, SCRIPT_RESULT_MAX_CHARS);
      } catch (error) {
        return `ERROR: ${String(error instanceof Error ? error.message : error).slice(0, SCRIPT_RESULT_MAX_CHARS)}`;
      }
    },
    nowMs: () => Date.now(),
  });
}

// src/agent/durable-object.ts — THE AGENT: the facet the context at any path hosts under the name
// `agent` (`itx.agents.get(path)`, library.ts — hosted on its first call, addressed after). The loop is
// the processor's (processor.ts); this host is what the processor cannot be: the two effects reached
// through `itx` — the model (a `@cf/…` model through `itx.ai`, the Workers AI binding under THIS
// context's rules, so a test lends a fake there; an OpenAI model through the account's AI Gateway
// with the platform's key, streamed from the Responses API) and the files — a script the loop asks
// for is the CONTEXT's to run (`context/run-requested`, iterate-context-durable-object.ts) —
// plus the two doors a client calls: `create()`, which lands the birth (the certificate cross-posted to
// `/` first, then on this path with the system prompt beside it), and `message(text)`, a person's words.
// The library enables the processor row beside `create()`: subscribed, the loop runs on every commit
// and after every eviction. Hosted from `ctx.exports` (first-party-facets.ts):
// ordinary bundled worker code.
import { z } from "zod";
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/next/sdk";
import type { StreamEvent } from "iterate/next/stream/processor";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import { type AppConfigEnv, appConfigOf } from "../app-config.ts";
import {
  type AgentView,
  type ChatMessage,
  type FileAttachment,
  type LlmUsage,
} from "./contract.ts";
import { AgentProcessor } from "./processor.ts";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "./system-prompt.ts";

/** What Workers AI answers when it does not stream: `{ response }`, or the chat-completions shape. */
const ChatAnswer = z.union([
  z.object({ response: z.string() }),
  z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) }),
]);

/** The usage a provider reports, both dialects (apps/os's `LlmUsage`): OpenAI Responses
 *  (`input_tokens`/`output_tokens`) and chat completions (`prompt_tokens`/`completion_tokens`),
 *  with the cached/reasoning breakdowns when present. Loose: vendors keep adding fields. */
const ProviderUsage = z.looseObject({
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  prompt_tokens_details: z
    .looseObject({ cached_tokens: z.number().int().nonnegative().optional() })
    .optional(),
  completion_tokens_details: z
    .looseObject({ reasoning_tokens: z.number().int().nonnegative().optional() })
    .optional(),
  input_tokens_details: z
    .looseObject({ cached_tokens: z.number().int().nonnegative().optional() })
    .optional(),
  output_tokens_details: z
    .looseObject({ reasoning_tokens: z.number().int().nonnegative().optional() })
    .optional(),
});

function normalizeUsage(raw: unknown): LlmUsage | undefined {
  const parsed = ProviderUsage.safeParse(raw);
  if (!parsed.success) return undefined;
  const inputTokens = parsed.data.prompt_tokens ?? parsed.data.input_tokens;
  const outputTokens = parsed.data.completion_tokens ?? parsed.data.output_tokens;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cachedInputTokens =
    parsed.data.prompt_tokens_details?.cached_tokens ??
    parsed.data.input_tokens_details?.cached_tokens;
  const reasoningOutputTokens =
    parsed.data.completion_tokens_details?.reasoning_tokens ??
    parsed.data.output_tokens_details?.reasoning_tokens;
  return { inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens };
}

/** One OpenAI Responses API stream event — the ones this loop reads; the rest pass through as
 *  chunks a feed may ignore. */
const ResponsesEvent = z.looseObject({ type: z.string() });

/** Read an SSE body frame by frame, handing each `data:` JSON to `onEvent`; the reader is cancelled
 *  when `signal` aborts, so nothing lands after the caller has settled. */
async function drainSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: unknown) => void,
): Promise<void> {
  const reader = body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  if (signal.aborted) cancel();
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let buffered = "";
  const frame = (text: string) => {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");
    if (data === "" || data === "[DONE]") return;
    try {
      onEvent(JSON.parse(data));
    } catch {
      onEvent(data);
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const frames = buffered.split(/\r?\n\r?\n/);
      buffered = frames.pop() || "";
      frames.forEach(frame);
    }
    buffered += decoder.decode();
    if (buffered.trim()) frame(buffered);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

/** Race an un-abortable dial against the caller's signal (apps/os's `raceAbort`): the caller regains
 *  control the moment it aborts — an interruption, the expiry, the idle watchdog — while the orphaned
 *  dial finishes into the void; a stream already open is cancelled by `drainSse` itself. */
function raceAbort<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason || new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** The conversation as the Responses API takes it: `input` items with text and image parts. */
function responsesInput(messages: ChatMessage[]) {
  return messages.map((message) =>
    typeof message.content === "string"
      ? { role: message.role, content: message.content }
      : {
          role: message.role,
          content: message.content.map((part) =>
            part.type === "text"
              ? { type: "input_text", text: part.text }
              : { type: "input_image", image_url: part.image_url.url, detail: "auto" },
          ),
        },
  );
}

export class AgentDurableObject extends StreamProcessorDurableObject<
  AgentView,
  { ITX?: ItxEntrypointService; AI: Ai } & AppConfigEnv,
  ItxEntrypointScope
> {
  processor = new AgentProcessor({
    stream: async ({ model, messages, signal, onChunk }) => {
      // Two routes by the model's name. A `@cf/…` model is Workers AI through `itx.ai` (the binding
      // under THIS context's rules — a test lends a fake there), streamed when the binding streams.
      // Anything else is OpenAI's Responses API as a Workers AI partner model on Cloudflare's billing
      // — no key, ours or a project's — the FAST reading of a reasoning model: low effort, with its
      // summary streamed.
      if (model.startsWith("@cf/")) {
        // workers-types keys `run`'s inputs and outputs by model-name literal; the model is
        // configuration here (any name the account can reach), so the call is made through the
        // binding's runtime shape and the answer is validated below rather than trusted from a type.
        const raw: unknown = await raceAbort(
          signal,
          this.withItx((itx) =>
            (itx.ai as unknown as { run(model: string, inputs: unknown): Promise<unknown> }).run(
              model,
              { messages, stream: true },
            ),
          ),
        );
        if (raw instanceof ReadableStream) {
          let text = "";
          let usage: LlmUsage | undefined;
          await drainSse(raw, signal, (event) => {
            const chunk = z.looseObject({ response: z.string().optional() }).safeParse(event);
            const delta = chunk.success ? chunk.data.response || "" : "";
            text += delta;
            onChunk(event, delta);
            const reported = z.looseObject({ usage: z.unknown() }).safeParse(event);
            if (reported.success && reported.data.usage !== undefined)
              usage = normalizeUsage(reported.data.usage) ?? usage;
          });
          if (text.trim() === "") throw new Error("the model answered with no text");
          return { text: text.trim(), usage };
        }
        // A binding (or a lent fake) that answered whole: the one chunk there is.
        const answer = ChatAnswer.parse(raw);
        const text = (
          "response" in answer ? answer.response : answer.choices[0]!.message.content
        ).trim();
        if (text === "") throw new Error("the model answered with no text");
        onChunk(raw, text);
        return { text };
      }
      // No key of ours rides this request: an `openai/…` model is a Workers AI PARTNER model, billed
      // by Cloudflare through the binding (apps/os's `unified` transport) — the Responses API shape,
      // streamed, the raw Response asked for so the SSE body is ours to read. The gateway option
      // routes it through the account's AI Gateway; its metadata is what the gateway's spend limits
      // partition on (apps/os's: environment, project, stream), so a runaway agent hits ITS ceiling.
      // Two casts, both because workers-types spells Workers AI's OWN catalog as literals: a partner
      // model's name (`openai/…`) is not among them though the binding takes any model the account
      // can reach, and a partner model takes the PROVIDER's request body (here the Responses API's),
      // which no catalog input type names. Nothing is trusted from either: the answer is a Response
      // checked for status and parsed event by event below.
      const config = appConfigOf(this.env);
      const { projectId, path } = await this.#identity();
      const raw: unknown = await raceAbort(
        signal,
        this.env.AI.run(
          `openai/${model}` as Parameters<Ai["run"]>[0],
          {
            input: responsesInput(messages),
            stream: true,
            store: false,
            reasoning: { effort: "low", summary: "auto" },
          } as never,
          {
            returnRawResponse: true,
            gateway: {
              id: config.aiGatewayId,
              skipCache: true,
              metadata: {
                environment: config.environmentName,
                projectId,
                streamPath: path,
                context: "agent-turn",
              },
            },
          },
        ),
      );
      if (!(raw instanceof Response))
        throw new Error(`model ${model}: Workers AI did not answer with the raw response`);
      const response = raw;
      if (!response.ok || !response.body)
        throw new Error(
          `openai/${model} ${String(response.status)}: ${(await response.text()).slice(0, 400)}`,
        );
      let text = "";
      let usage: LlmUsage | undefined;
      await drainSse(response.body, signal, (raw) => {
        const event = ResponsesEvent.safeParse(raw);
        if (!event.success) return;
        const { type } = event.data;
        if (type === "response.output_text.delta") {
          const delta = typeof event.data.delta === "string" ? event.data.delta : "";
          text += delta;
          onChunk(raw, delta);
        } else if (type === "response.reasoning_summary_text.delta") onChunk(raw, "");
        else if (type === "response.completed" || type === "response.incomplete") {
          const done = z
            .looseObject({ response: z.looseObject({ usage: z.unknown() }) })
            .safeParse(raw);
          if (done.success) usage = normalizeUsage(done.data.response.usage) ?? usage;
        } else if (type === "response.failed" || type === "error") {
          const failure = z
            .looseObject({
              error: z.looseObject({ message: z.string() }).optional(),
              response: z
                .looseObject({ error: z.looseObject({ message: z.string() }).optional() })
                .optional(),
            })
            .safeParse(raw);
          throw new Error(
            `openai: ${failure.success ? failure.data.error?.message || failure.data.response?.error?.message || type : type}`,
          );
        }
      });
      if (text.trim() === "") throw new Error("the model answered with no text");
      return { text: text.trim(), usage };
    },
    readFile: (path) => this.withItx((itx) => itx.files.get(path).bytes()),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  #identityRead?: { projectId: string; path: string };
  /** Which context this is — its project and path — read once. */
  async #identity(): Promise<{ projectId: string; path: string }> {
    return (this.#identityRead ??= await this.withItx((itx) => itx.whoami()));
  }
  async #path(): Promise<string> {
    return (await this.#identity()).path;
  }

  /** Bring the agent into being: the certificate on `/` (the catalog) first, then on this path with
   *  the system prompt beside it (nothing to provision, so nothing fails). A caller's `systemPrompt`
   *  is ADDED to the platform's rules (the codemode format, the itx surface), never a replacement:
   *  an agent told only "be terse" must still know how to act. Idempotent: a created agent answers
   *  at once. `message()` refuses until this has run. */
  async create(input: { systemPrompt?: string } = {}): Promise<{ path: string }> {
    const path = await this.#path();
    if ((await this.snapshot()).state.path !== null) return { path };
    const projectContext = `\nCURRENT PROJECT: ${JSON.stringify(await this.withItx((itx) => itx.whoami()))}`;
    const certificate = {
      type: "events.iterate.com/agent/created",
      payload: { path },
      idempotencyKey: `agent/created:${path}`,
    };
    await this.withItx((itx) => itx.cd("/").append(certificate));
    await this.withItx((itx) =>
      itx.append(certificate, {
        type: "events.iterate.com/agents/context-added",
        idempotencyKey: `agent/system-prompt:${path}`,
        payload: {
          role: "system",
          content: input.systemPrompt
            ? `${DEFAULT_AGENT_SYSTEM_PROMPT}\n\nINSTRUCTIONS FROM THE OPERATOR (they add to the rules above, never replace them):\n${input.systemPrompt}${projectContext}`
            : DEFAULT_AGENT_SYSTEM_PROMPT + projectContext,
        },
      }),
    );
    this.#confirmedCreated = true;
    return { path };
  }

  /** A person's words: ONE `context-added`, the trigger of the next turn — with their attachments,
   *  each stored first under this agent's path (`itx.files`, apps/os's `<path>/<8 of a uuid>-<name>`)
   *  and named on the event; an image among them is what the model will see. The event is answered
   *  so a caller can wait for what follows it. */
  async message(
    input:
      | string
      | {
          message: string;
          files?: {
            contentType: string;
            filename: string;
            data: Uint8Array | ArrayBuffer | string;
          }[];
        },
  ): Promise<StreamEvent> {
    await this.#created();
    const { message, files = [] } = typeof input === "string" ? { message: input } : input;
    const path = await this.#path();
    const attachments: FileAttachment[] = [];
    for (const file of files) {
      const filename = file.filename.replace(/[^A-Za-z0-9._-]+/g, "-");
      const storedAt = `${path}/${crypto.randomUUID().slice(0, 8)}-${filename}`;
      const stored = await this.withItx((itx) =>
        itx.files.get(storedAt).put({ contentType: file.contentType, data: file.data }),
      );
      attachments.push({
        contentType: stored.contentType,
        filename: file.filename,
        path: stored.path,
        size: stored.size,
      });
    }
    const appended = await this.withItx((itx) =>
      itx.append({
        type: "events.iterate.com/agents/context-added",
        payload: {
          role: "user",
          content: message,
          actor: { type: "user" },
          ...(attachments.length > 0 && { files: attachments }),
        },
      }),
    );
    // Over the loopback stub the append's answer types as an RPC result, not the array the door
    // declares (`append(...events): Promise<StreamEvent[]>`, context/built-ins.ts); the wire copied it.
    return (appended as unknown as StreamEvent[])[0]!;
  }

  /** Every door past `create()` starts here: an agent not yet created refuses. Creation is terminal,
   *  so the answer is memoized once seen. */
  #confirmedCreated = false;
  async #created(): Promise<void> {
    if (this.#confirmedCreated) return;
    if ((await this.snapshot()).state.path === null)
      throw new Error(`agent ${await this.#path()}: not created — call create() first`);
    this.#confirmedCreated = true;
  }
}

// =============================================================================
// Workers AI transport: how one LLM attempt talks to `env.AI`.
// =============================================================================
// Wire format and wall clock only — no journal. The agent processor owns what
// becomes a stream event; this module owns dialing the binding, draining its
// SSE response, guessing assistant text/usage out of the shapes Workers AI
// models actually return, and capping the whole attempt's lifetime.

/** The `env.AI` surface one attempt needs. */
export type WorkersAiBinding = { run(model: string, body: unknown): Promise<unknown> };

type WorkersAiCompletion = {
  /** Assistant text — concatenated across chunks for streamed responses. */
  text: string;
  /** JSON-safe response evidence for the journal (never a live object graph). */
  rawResponse: unknown;
  usage?: unknown;
};

/**
 * One complete attempt: dial `ai.run`, drain the response (streaming or not),
 * and enforce `deadlineMs` over the WHOLE phase — dial plus drain. The cap is
 * load-bearing for recovery: the caller tracks the attempt in a live-execution
 * set its reconciler skips, so an unbounded hang here would push every wedge
 * out to the agent's last-resort backstop instead of failing within the
 * attempt's own horizon.
 *
 * `onChunk` fires once per parsed SSE chunk, in order and awaited, so the
 * caller can journal chunks as events without racing the drain.
 */
export async function runWorkersAiAttempt(input: {
  ai: WorkersAiBinding;
  deadlineMs: number;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  model: string;
  onChunk: (chunk: unknown, index: number) => Promise<void>;
}): Promise<WorkersAiCompletion> {
  return await withDeadline({
    deadlineMs: input.deadlineMs,
    message: `LLM attempt timed out after ${input.deadlineMs / 60_000} minutes.`,
    work: (async () => {
      const raw = await input.ai.run(input.model, { messages: input.messages, stream: true });
      if (raw instanceof ReadableStream) {
        return await drainSseResponse({ body: raw, onChunk: input.onChunk });
      }
      return {
        text: extractAssistantText(raw),
        rawResponse: jsonCompatible(raw),
        usage: extractUsage(raw),
      };
    })(),
  });
}

async function withDeadline<T>(input: {
  deadlineMs: number;
  message: string;
  work: Promise<T>;
}): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      input.work,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(input.message)), input.deadlineMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/** Parse SSE frames off the response stream, handing each chunk to `onChunk`
 * and accumulating the assistant text and last-seen usage. */
async function drainSseResponse(input: {
  body: ReadableStream;
  onChunk: (chunk: unknown, index: number) => Promise<void>;
}): Promise<WorkersAiCompletion> {
  const reader = input.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let chunkCount = 0;
  let text = "";
  let usage: unknown;

  const handleChunk = async (chunk: unknown) => {
    text += extractChunkText(chunk);
    usage = extractUsage(chunk) ?? usage;
    await input.onChunk(chunk, chunkCount);
    chunkCount += 1;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += typeof value === "string" ? value : decoder.decode(value, { stream: true });
    const frames = buffered.split(/\r?\n\r?\n/);
    buffered = frames.pop() ?? "";
    for (const frame of frames) {
      const chunk = parseSseFrame(frame);
      if (chunk !== undefined) await handleChunk(chunk);
    }
  }
  buffered += decoder.decode();
  const finalChunk = parseSseFrame(buffered);
  if (finalChunk !== undefined) await handleChunk(finalChunk);

  return {
    rawResponse: {
      streamed: true,
      chunkCount,
      response: text,
      ...(usage === undefined ? {} : { usage }),
    },
    text,
    ...(usage === undefined ? {} : { usage }),
  };
}

function parseSseFrame(frame: string): unknown | undefined {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");
  if (data === "" || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

// Response-shape guessing below: Workers AI is not one wire format. Text
// models answer `{ response }`, OpenAI-compatible chat models answer
// `{ choices: [{ message | delta }] }`, and some return content-block arrays.

function extractAssistantText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw !== "object" || raw === null) {
    throw new Error("AI response did not contain assistant text.");
  }
  if ("response" in raw && typeof raw.response === "string") return raw.response;

  const choices = (raw as { choices?: unknown }).choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as
      | { message?: { content?: unknown }; delta?: { content?: unknown } }
      | undefined;
    const content = first?.message?.content ?? first?.delta?.content;
    if (typeof content === "string") return content;
  }

  const content = (raw as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
          ? block.text
          : "",
      )
      .join("");
  }

  throw new Error("AI response did not contain assistant text.");
}

function extractChunkText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (typeof chunk !== "object" || chunk === null) return "";
  if ("response" in chunk && typeof chunk.response === "string") return chunk.response;

  const choices = (chunk as { choices?: unknown }).choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as { delta?: { content?: unknown } } | undefined;
    if (typeof first?.delta?.content === "string") return first.delta.content;
  }

  const delta = (chunk as { delta?: { text?: unknown } }).delta;
  return typeof delta?.text === "string" ? delta.text : "";
}

function extractUsage(raw: unknown): unknown | undefined {
  return typeof raw === "object" && raw !== null && "usage" in raw ? raw.usage : undefined;
}

/** JSON round-trip so journaled evidence can never carry live references. */
export function jsonCompatible(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

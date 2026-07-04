/**
 * Live proof that the pi stream processor drives a REAL LLM agent whose ONLY
 * tool is `execute(itxScript)`.
 *
 * Nothing here is faked: a real Claude model (via the Anthropic Messages API)
 * runs turns through the exact PiProcessor from pi-processor-implementation.ts.
 * The single tool runs an `async (itx) => {...}` script against a real itx-like
 * surface (bash / read / write in a scratch dir) and feeds the result back —
 * pi's codemode as one explicit tool inside pi's turn loop.
 *
 * Run:
 *   cd apps/os
 *   doppler run --config dev -- pnpm tsx scripts/pi-live-demo.ts
 * (Doppler supplies ANTHROPIC_API_KEY. Any env with the key set works.)
 *
 * This is a manual verification harness, not part of the test suite or build —
 * it makes a billed network call and touches a temp dir. Raw HTTP (no SDK dep)
 * is deliberate: keep the green PR's lockfile untouched for a throwaway proof.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Stream, StreamEvent, StreamEventInput } from "../src/types.ts";
import type {
  PiAssistantContent,
  PiAssistantMessage,
} from "../src/domains/pi/pi-processor-contract.ts";
import {
  PiProcessor,
  type PiLlmMessage,
  type PiLlmRequest,
  type PiToolDep,
} from "../src/domains/pi/pi-processor-implementation.ts";

const MODEL = "claude-opus-4-8";
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// In-memory stream: the same append-with-idempotency-dedup the real Stream DO
// gives the processor, minus the durable/subscription machinery the host adds.
// ---------------------------------------------------------------------------
class MemoryStream {
  readonly events: StreamEvent[] = [];

  async append(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
    return inputs.map((input) => {
      const existing =
        input.idempotencyKey === undefined
          ? undefined
          : this.events.find((event) => event.idempotencyKey === input.idempotencyKey);
      if (existing !== undefined) return existing;
      const event: StreamEvent = {
        ...input,
        createdAt: new Date(this.events.length + 1).toISOString(),
        offset: this.events.length + 1,
      };
      this.events.push(event);
      return event;
    });
  }

  async getEvent(
    input: { offset: number } | { idempotencyKey: string },
  ): Promise<StreamEvent | undefined> {
    if ("offset" in input) return this.events.find((e) => e.offset === input.offset);
    return this.events.find((e) => e.idempotencyKey === input.idempotencyKey);
  }

  async getEvents(): Promise<StreamEvent[]> {
    return [...this.events];
  }
}

// ---------------------------------------------------------------------------
// The LLM dependency: pi's PiLlmRequest ⇄ Anthropic Messages API with tool use.
// Mirrors pi's StreamFn contract loosely — it may throw; PiProcessor catches
// and encodes the failure as stopReason "error"/"aborted".
// ---------------------------------------------------------------------------
function anthropicLlm(apiKey: string) {
  const toAnthropicMessages = (messages: PiLlmMessage[]) =>
    messages.map((message) => {
      switch (message.role) {
        case "user":
          return { role: "user" as const, content: message.content };
        case "assistant":
          return {
            role: "assistant" as const,
            content: message.content
              .filter((block) => block.type !== "thinking")
              .map((block) =>
                block.type === "text"
                  ? { type: "text" as const, text: block.text }
                  : {
                      type: "tool_use" as const,
                      id: block.id,
                      name: block.name,
                      input: block.arguments,
                    },
              ),
          };
        case "toolResult":
          return {
            role: "user" as const,
            content: [
              {
                type: "tool_result" as const,
                tool_use_id: message.toolCallId,
                content: message.content,
                is_error: message.isError,
              },
            ],
          };
      }
    });

  const toStopReason = (reason: string): PiAssistantMessage["stopReason"] => {
    switch (reason) {
      case "tool_use":
        return "toolUse";
      case "max_tokens":
        return "length";
      case "refusal":
        return "error";
      default:
        return "stop";
    }
  };

  return {
    async complete(
      request: PiLlmRequest,
      { signal }: { signal: AbortSignal },
    ): Promise<PiAssistantMessage> {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal,
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: 16_000,
          system: request.systemPrompt,
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
          messages: toAnthropicMessages(request.messages),
        }),
      });
      if (!response.ok) {
        throw new Error(`Anthropic ${response.status}: ${await response.text()}`);
      }
      const data = (await response.json()) as {
        content: Array<{
          type: string;
          text?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
        }>;
        stop_reason: string;
        usage: { input_tokens: number; output_tokens: number };
      };
      return {
        role: "assistant",
        stopReason: toStopReason(data.stop_reason),
        content: data.content.flatMap((block): PiAssistantContent[] => {
          if (block.type === "text" && block.text !== undefined)
            return [{ type: "text", text: block.text }];
          if (block.type === "tool_use" && block.id !== undefined)
            return [
              {
                type: "toolCall",
                id: block.id,
                name: block.name ?? "",
                arguments: block.input ?? {},
              },
            ];
          return [];
        }),
        usage: {
          input: data.usage.input_tokens,
          output: data.usage.output_tokens,
          totalTokens: data.usage.input_tokens + data.usage.output_tokens,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The ONE tool: execute(script). Runs `async (itx) => {...}` against a real
// itx-shaped surface (bash / read / write, sandboxed to a scratch dir) and
// returns whatever the script returns.
// ---------------------------------------------------------------------------
function executeTool(workdir: string): PiToolDep {
  const within = (path: string) => {
    const abs = isAbsolute(path) ? path : join(workdir, path);
    const full = resolve(abs);
    if (full !== workdir && !full.startsWith(workdir + "/")) {
      throw new Error(`path escapes the scratch dir: ${path}`);
    }
    return full;
  };
  const itx = {
    async sh(command: string) {
      try {
        const { stdout, stderr } = await execFileAsync("bash", ["-lc", command], {
          cwd: workdir,
          timeout: 30_000,
        });
        return { stdout, stderr, exitCode: 0 };
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string; code?: number; message: string };
        return { stdout: e.stdout ?? "", stderr: e.stderr ?? e.message, exitCode: e.code ?? 1 };
      }
    },
    async read(path: string) {
      return await readFile(within(path), "utf8");
    },
    async write(path: string, content: string) {
      await writeFile(within(path), content, "utf8");
      return { written: path, bytes: Buffer.byteLength(content) };
    },
  };

  return {
    description:
      "Run a JavaScript snippet of the form `async (itx) => { ... }` and return its result. " +
      "Every `itx` method is ASYNC — you MUST `await` it (or Promise.all a batch). " +
      "itx.sh(command) → { stdout, stderr, exitCode } (bash in a scratch dir); " +
      "itx.read(path) → string; itx.write(path, content) → { written, bytes }. " +
      "Whatever the function returns (JSON-serializable) comes back to you. " +
      "Reply with plain text (no tool call) when the task is done.",
    parameters: z.object({
      script: z.string().describe("An `async (itx) => { ... }` arrow function, as source text."),
    }),
    async execute(args, signal) {
      if (signal.aborted) return { content: "aborted", isError: true };
      const { script } = args as { script: string };
      // Contain stray rejections from promises the script forgot to await, so
      // one late throw can't take down the whole agent process.
      const onUnhandled = (reason: unknown) => {
        console.warn("  (ignored unhandled rejection from script:", String(reason), ")");
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        // Dynamic evaluation IS the point: this is pi's "codemode" — the model
        // writes a script and we run it. Safe here (throwaway local demo, model
        // is the trusted author); a real deployment runs this in a sandbox.
        // eslint-disable-next-line no-new-func -- codemode: run the model's snippet
        const factory = new Function(`return (${script})`) as () => (itx: unknown) => unknown;
        const result = await factory()(itx);
        return { content: result === undefined ? "undefined" : JSON.stringify(result, null, 2) };
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true };
      } finally {
        setTimeout(() => process.off("unhandledRejection", onUnhandled), 100);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Driver: append a user message, then pump ingest until the run settles.
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = [
  "You are a coding agent whose only tool is `execute`. It runs an `async (itx) => { ... }` script and returns its result to you.",
  "`itx` gives you a real Linux scratch directory: itx.sh(command) runs bash, itx.read(path)/itx.write(path, content) touch files.",
  "Do real work through execute — inspect with itx.sh, create files with itx.write, verify by reading them back.",
  "When the task is complete, stop calling execute and reply with a short plain-text answer for the user.",
].join("\n");

const TASK =
  "Write a file haiku.txt in the scratch dir containing a haiku about event sourcing. " +
  "Then read it back and run `wc -l` on it. Tell me the haiku and confirm its line count.";

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey)
    throw new Error("ANTHROPIC_API_KEY not set (wrap in `doppler run --config dev --`).");

  const workdir = resolve(await mkdtemp(join(tmpdir(), "pi-live-")));
  const stream = new MemoryStream();
  const processor = new PiProcessor({
    stream: stream as unknown as Stream,
    llm: anthropicLlm(apiKey),
    tools: { execute: executeTool(workdir) },
  });

  console.log(`\n▶ model: ${MODEL}   scratch: ${workdir}`);
  console.log(`▶ single tool exposed to the model: execute(script)\n`);
  console.log(`USER: ${TASK}\n`);

  await stream.append(
    {
      type: "events.iterate.com/pi/config-updated",
      payload: { model: MODEL, systemPrompt: SYSTEM_PROMPT },
    },
    { type: "events.iterate.com/pi/user-message-received", payload: { text: TASK } },
  );

  // Pump: hand every newly-appended event to the processor (the role the real
  // subscription host plays) until the loop goes idle with nothing pending.
  let cursor = 0;
  let printed = 0;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const fresh = stream.events.slice(cursor);
    cursor = stream.events.length;
    if (fresh.length > 0) {
      await processor.ingest({ events: fresh, streamMaxOffset: stream.events.length });
    }
    // Narrate the model-visible events as they land.
    for (; printed < stream.events.length; printed++) {
      const event = stream.events[printed]!;
      if (event.type === "events.iterate.com/pi/assistant-message-added") {
        const message = (event.payload as { message: PiAssistantMessage }).message;
        for (const block of message.content) {
          if (block.type === "text" && block.text.trim())
            console.log(`ASSISTANT: ${block.text.trim()}\n`);
          if (block.type === "toolCall")
            console.log(
              `  ↳ execute(${JSON.stringify((block.arguments as { script?: string }).script ?? block.arguments)})\n`,
            );
        }
      }
      if (event.type === "events.iterate.com/pi/tool-result-added") {
        const payload = event.payload as { content: string; isError: boolean };
        const label = payload.isError ? "TOOL ERROR" : "TOOL RESULT";
        console.log(`  ↳ ${label}: ${payload.content.replace(/\n/g, "\n            ")}\n`);
      }
    }
    if (processor.state.run.phase === "idle" && !processor.state.pendingTrigger) break;
    await new Promise((r) => setTimeout(r, 40));
  }

  const turns = stream.events.filter(
    (e) => e.type === "events.iterate.com/pi/assistant-message-added",
  ).length;
  const toolCalls = stream.events.filter(
    (e) => e.type === "events.iterate.com/pi/tool-result-added",
  ).length;
  console.log(
    `✔ done — ${turns} model turns, ${toolCalls} execute() calls, all through PiProcessor.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

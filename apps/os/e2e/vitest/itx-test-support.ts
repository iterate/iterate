import http from "node:http";
import { RpcTarget } from "capnweb";
import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import { isStreamOffsetConflictError } from "iterate/processors";
import { StreamProcessor } from "iterate/processors";
import type { Stream, StreamEvent, StreamEventInput } from "../../src/itx-api.generated.ts";
import type { DynamicWorkerRef } from "../../src/domains/workers/schemas.ts";

export const PROJECT_WORKER_FORWARDED_EVENT_TYPE = "events.iterate.test/project-worker-forwarded";
export const AGENT_WEB_MESSAGE_SENT_TYPE = "events.iterate.com/agents/web-message-sent";
export const AGENT_CONTEXT_ADDED_TYPE = "events.iterate.com/agents/context-added";
export const EGRESS_PROOF_HEADER = "x-itx-egress-proof";

/** Journal a synthetic provider response with the same durable
 * request/settlement evidence the agent processor requires before assistant
 * code is executable: a requested event whose OWN offset is the request's
 * identity, the assistant context item linked to it, and the settled fact
 * closing it. Keeping this in one helper prevents e2e from weakening or lying
 * about that trust boundary merely to bypass the paid provider call. */
export async function appendSyntheticProviderOutput(
  stream: Stream,
  content: string,
): Promise<{ assistantContext: StreamEvent; llmRequestOffset: number }> {
  const model = "e2e/synthetic-provider";
  // `offset` is the Stream DO's hidden optimistic assertion. Keeping the
  // whole lifecycle in one asserted append means no subscriber can observe a
  // bare requested event and start a real provider attempt in the gap. The
  // generated public type omits this expert-only assertion intentionally, so
  // this e2e helper contains the one local cast.
  const asserted = (offset: number, event: StreamEventInput): StreamEventInput =>
    ({ ...event, offset }) as StreamEventInput;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { coreProcessorState } = await stream.runtimeState();
    if (
      coreProcessorState == null ||
      typeof coreProcessorState !== "object" ||
      typeof (coreProcessorState as { maxOffset?: unknown }).maxOffset !== "number"
    ) {
      throw new Error("Synthetic provider output could not read the stream's maxOffset.");
    }
    const llmRequestOffset = (coreProcessorState as { maxOffset: number }).maxOffset + 1;
    try {
      const [, assistantContext] = await stream.append(
        asserted(llmRequestOffset, {
          type: "events.iterate.com/agent/llm-request-requested",
          payload: { model, expiresAt: Date.now() + 60_000 },
        }),
        asserted(llmRequestOffset + 1, {
          type: AGENT_CONTEXT_ADDED_TYPE,
          payload: { role: "assistant", content, llmRequestOffset },
        }),
        asserted(llmRequestOffset + 2, {
          type: "events.iterate.com/agent/llm-request-settled",
          idempotencyKey: `agent/llm-request-settled@${llmRequestOffset}`,
          payload: {
            requestOffset: llmRequestOffset,
            durationMs: 0,
            result: { status: "succeeded", text: content },
          },
        }),
      );
      return { assistantContext: assistantContext!, llmRequestOffset };
    } catch (error) {
      if (!isStreamOffsetConflictError(error) || attempt === 19) throw error;
    }
  }
  throw new Error("Synthetic provider output exhausted its offset retries.");
}

// Not exported: only the processor class below crosses module boundaries;
// the contract value/type stay internal (knip flags unused exports).
const ProjectWorkerForwardingProbeContract = defineProcessorContract({
  slug: "minimal-itx-v4.project-worker-forwarding-probe",
  version: "0.1.0",
  description:
    "Records project worker processEventBatch deliveries observed through an itx stream.",
  stateSchema: z.object({
    childPaths: z.array(z.string()).default([]),
    markers: z.array(z.string()).default([]),
  }),
  events: {
    [PROJECT_WORKER_FORWARDED_EVENT_TYPE]: {
      payloadSchema: z.object({
        childPath: z.string(),
        marker: z.string(),
        originalType: z.string(),
      }),
    },
  },
  consumes: [PROJECT_WORKER_FORWARDED_EVENT_TYPE],
  emits: [],
});
type ProjectWorkerForwardingProbeContract = typeof ProjectWorkerForwardingProbeContract;
export type ProjectWorkerForwardingProbeState = {
  childPaths: string[];
  markers: string[];
};

export class ProjectWorkerForwardingProbeProcessor extends StreamProcessor<ProjectWorkerForwardingProbeContract> {
  readonly contract = ProjectWorkerForwardingProbeContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<ProjectWorkerForwardingProbeContract>["reduce"]>[0]) {
    return {
      childPaths: [...state.childPaths, event.payload.childPath],
      markers: [...state.markers, event.payload.marker],
    };
  }
}

function parseBody(body: string, contentType: string | string[] | undefined): Record<string, any> {
  if (typeof contentType === "string" && contentType.includes("application/json")) {
    try {
      return JSON.parse(body) as Record<string, any>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(body));
}

export function echoedEgressProofHeader(body: unknown): string {
  const headers =
    ((body as { headers?: Record<string, string | string[]> }).headers as Record<
      string,
      string | string[]
    >) ?? {};
  const value = headers[EGRESS_PROOF_HEADER] ?? headers[EGRESS_PROOF_HEADER.toUpperCase()] ?? "";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

export function startMockSlack(): Promise<{
  calls: string[];
  close(): Promise<void>;
  url: string;
}> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    const method = (req.url ?? "").replace(/^\//, "").split("?")[0] ?? "";
    calls.push(method);

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const payload = parseBody(body, req.headers["content-type"]);
      res.setHeader("content-type", "application/json");
      if (method === "chat.postMessage") {
        res.end(
          JSON.stringify({
            ok: true,
            channel: payload.channel,
            ts: "1718000000.000100",
            message: { text: payload.text, type: "message" },
            via: "mock-slack-api",
          }),
        );
        return;
      }
      if (method === "users.list") {
        res.end(
          JSON.stringify({
            ok: true,
            members: [
              { id: "U1", name: "ada" },
              { id: "U2", name: "grace" },
            ],
            via: "mock-slack-api",
          }),
        );
        return;
      }
      res.end(JSON.stringify({ ok: true, via: "mock-slack-api" }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        calls,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
        url: `http://127.0.0.1:${port}/`,
      });
    });
  });
}

export class PathFunctionTarget extends RpcTarget {
  constructor(readonly target: unknown) {
    super();
  }

  invokeCapability({ args, path }: { args: unknown[]; path: string[] }) {
    if (path.length === 0) return this.target;

    let receiver = this.target;
    for (const segment of path.slice(0, -1)) {
      if (receiver === null || (typeof receiver !== "object" && typeof receiver !== "function")) {
        throw new Error(`path "${path.join(".")}" hit ${String(receiver)}`);
      }
      receiver = Reflect.get(receiver, segment);
    }

    const method = path.at(-1)!;
    if (receiver === null || (typeof receiver !== "object" && typeof receiver !== "function")) {
      throw new Error(`path "${path.join(".")}" hit ${String(receiver)}`);
    }
    const handler = Reflect.get(receiver, method);
    if (typeof handler !== "function") {
      throw new Error(`path "${path.join(".")}" did not resolve to a function`);
    }
    return Reflect.apply(handler, receiver, args);
  }
}

/**
 * Inline plain-JavaScript worker source with bundling off — the loader-ready
 * fast path. Tests that exercise the full build pipeline (TypeScript,
 * multi-file imports, npm dependencies) construct their sources explicitly.
 */
export function inlineJsSource(entryPoint: string, files: Record<string, string>) {
  return {
    files: { files, type: "inline" as const },
    options: { bundle: false as const, entryPoint },
  };
}

/**
 * A throwaway inline dynamic worker whose bare `fetch()` proves the egress
 * path (dynamic workers' global fetch rides project egress, secret
 * substitution included) — the probe is the TEST's worker, not a method on
 * the seeded template.
 */
export function egressProbeWorker(project: { workers: { get(ref: DynamicWorkerRef): unknown } }) {
  return project.workers.get({
    path: "/",
    source: inlineJsSource("probe.js", {
      "probe.js": `
        import { WorkerEntrypoint } from "cloudflare:workers";
        export default class extends WorkerEntrypoint {
          async probeFetch(input) {
            const response = await fetch(input.url, {
              headers: { "x-itx-egress-proof": input.headerValue },
            });
            return await response.json();
          }

          async probeSecretResponse(input) {
            const project = await this.env.ITX.get();
            try {
              const secret = project.secrets.get(input.secretPath);
              try {
                const response = await secret.fetch(new Request(input.url));
                return {
                  body: await response.json(),
                  redirected: response.redirected,
                  url: response.url,
                };
              } finally {
                secret[Symbol.dispose]?.();
              }
            } finally {
              project[Symbol.dispose]?.();
            }
          }
        }
      `,
    }),
    type: "stateless",
  }) as unknown as {
    probeFetch(input: { headerValue: string; url: string }): Promise<unknown>;
    probeSecretResponse(input: { secretPath: string; url: string }): Promise<{
      body: unknown;
      redirected: boolean;
      url: string;
    }>;
  } & Disposable;
}

export function fencedAgentScript(code: string): string {
  return ["The faux LLM produced this codemode block.", "```ts", code.trim(), "```"].join("\n");
}

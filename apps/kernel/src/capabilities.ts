import { RpcTarget } from "cloudflare:workers";
import { controlPlaneEgress, projectSecrets, type PlatformSecret } from "./egress.ts";
import type { StreamDurableObject, StreamEvent, StreamEventInput } from "./stream-do.ts";

// ---------------------------------------------------------------------------
// THE ONE PROJECT CAPABILITY TREE (D-A, 2026-07-31). A single nested `RpcTarget` surface —
// `project.streams.get(path).append()`, `project.secrets.set()`, `project.ai.run()` — shared by BOTH
// doors into a project: the capnweb `/api` `Project` and the in-worker loopback `ProjectEntrypoint`
// (`env.ITX`). Before this there were two disjoint surfaces (control verbs on the capnweb Project, flat
// methods on ProjectEntrypoint); the promised tree was never built (thermonuclear review R7 D-A). capnweb's
// `RpcTarget` IS the `cloudflare:workers` one, so the same class tree serves both transports; nested
// getters are promise-pipelined (one round trip). Each target captures only (env-slice, projectId, cfg).
//
// The egress door (`fetch`) is NOT here — it must stay a real `Fetcher.fetch` on the WorkerEntrypoint
// (globalOutbound + WS upgrades). `exec`/dynamic-capabilities are control-plane (MCP), not the project
// tree (they need ctx.exports + the loader; R4 security decision).
// ---------------------------------------------------------------------------

export type CapabilityEnv = {
  STREAM_DO?: DurableObjectNamespace<StreamDurableObject>;
  SECRETS_KV?: KVNamespace;
  AI?: Ai;
};
export type CapabilityConfig = {
  product?: { platformSecrets?: PlatformSecret[] };
  ai?:
    | { source: "local"; model?: string }
    | { source: "remote"; endpoint: string; secretName: string; model?: string };
};

// Best-effort platform-secret usage meter (the billing hook). Floats the KV write (no ExecutionContext
// needed, so the same meter serves the capnweb path and the loopback path). Races under load — a
// DO-backed meter is the real fix (morning brief). Returns undefined when no store is bound.
export function makeMeter(kv: KVNamespace | undefined): ((name: string) => void) | undefined {
  if (!kv) return undefined;
  return (name: string) => {
    void (async () => {
      const k = `meter:platform:${name}`;
      await kv.put(k, String(Number((await kv.get(k)) ?? "0") + 1));
    })();
  };
}

// `project.streams.get(path)` → append/read the durable log (stream-do.ts). Scoped by the unforgeable
// projectId, so a project can never reach another's streams.
class StreamHandle extends RpcTarget {
  constructor(
    private readonly ns: DurableObjectNamespace<StreamDurableObject> | undefined,
    private readonly projectId: string,
    private readonly path: string,
  ) {
    super();
  }
  #do() {
    if (!this.ns) throw new Error("no STREAM_DO bound — streams unavailable in this deployment");
    return this.ns.getByName(`${this.projectId}::${this.path}`);
  }
  // Accept the canonical `StreamEventInput`, or a bare `type` string as ergonomic shorthand.
  append(input: StreamEventInput | string): Promise<StreamEvent> {
    const ev: StreamEventInput = typeof input === "string" ? { type: input, payload: {} } : input;
    return this.#do().append(ev);
  }
  read(afterOffset = 0): Promise<StreamEvent[]> {
    return this.#do().read(afterOffset);
  }
}
class Streams extends RpcTarget {
  constructor(
    private readonly ns: DurableObjectNamespace<StreamDurableObject> | undefined,
    private readonly projectId: string,
  ) {
    super();
  }
  get(path: string): StreamHandle {
    return new StreamHandle(this.ns, this.projectId, path);
  }
}

// `project.secrets.set(name, value)` — write-only from userspace (never read back; referenced in egress
// via `{{secret:project:<name>}}`).
class Secrets extends RpcTarget {
  constructor(
    private readonly kv: KVNamespace | undefined,
    private readonly projectId: string,
  ) {
    super();
  }
  // `allowedOrigins` (optional) origin-pins the secret — it then substitutes at egress ONLY for those
  // destinations (anti-exfiltration for the project's own secret; R8 follow-up). Omit for unrestricted.
  set(name: string, value: string, allowedOrigins?: string[]): Promise<void> {
    return projectSecrets(this.kv, this.projectId).set(name, value, allowedOrigins);
  }
}

// `project.ai.run(prompt)` — per-capability sourced (D-B/R3). local => this account's Workers AI; remote
// => a metered first-party endpoint through the control-plane egress door with a platform secret.
class AiCapability extends RpcTarget {
  constructor(
    private readonly env: CapabilityEnv,
    private readonly cfg: CapabilityConfig,
    private readonly meter: ((name: string) => void) | undefined,
  ) {
    super();
  }
  async run(prompt: string): Promise<string> {
    const ai = this.cfg.ai ?? { source: "local" };
    if (ai.source === "local") {
      if (!this.env.AI)
        throw new Error("no AI binding — bind Workers AI or configure ai.source=remote");
      const r = (await this.env.AI.run(ai.model ?? "@cf/meta/llama-3.2-1b-instruct", {
        prompt,
        max_tokens: 16,
      })) as { response?: string };
      return r.response ?? JSON.stringify(r);
    }
    const req = new Request(ai.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer {{secret:platform:${ai.secretName}}}`,
      },
      body: JSON.stringify({ model: ai.model, prompt }),
    });
    const res = await controlPlaneEgress(req, this.cfg.product?.platformSecrets ?? [], this.meter);
    return res.text();
  }
}

// The shared capability tree hung on both `Project` (capnweb) and `ProjectEntrypoint` (loopback).
export class ProjectCapabilities extends RpcTarget {
  constructor(
    private readonly env: CapabilityEnv,
    private readonly cfg: CapabilityConfig,
    private readonly projectId: string,
    private readonly meter: ((name: string) => void) | undefined,
  ) {
    super();
  }
  get streams(): Streams {
    return new Streams(this.env.STREAM_DO, this.projectId);
  }
  get secrets(): Secrets {
    return new Secrets(this.env.SECRETS_KV, this.projectId);
  }
  get ai(): AiCapability {
    return new AiCapability(this.env, this.cfg, this.meter);
  }
}

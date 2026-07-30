# Model 3, in code — answering "but the OS uses Cloudflare bindings"

Jonas's objection to "the OS dissolves into a project on the kernel": _we use
Cloudflare bindings (DO namespaces, R2, KV, AI, Browser, WorkerLoader…), which are
provided as capabilities — a confined project can't hold those._ Correct. Agent 3
overstated it. The precise version:

> **Raw Cloudflare bindings live in the KERNEL, which exposes them as
> capabilities. No project — not even the OS — holds raw bindings. The OS is
> userspace that additionally holds one privileged `operator` capability.**

This is the _same tangle_ Agent 1 found: today `ProjectDurableObject` is
simultaneously the capability _provider_ (holds bindings) and the feature _host_
(agent/Slack/etc.). Model 3 = unfuse those: **provider → kernel; features → userspace.**

---

## Sketch A — the kernel: the ONE thing that holds raw bindings

```ts
// packages/iterate-kernel/src/kernel-worker.ts   (the only privileged worker)
interface KernelEnv {
  // raw Cloudflare primitives — ONLY the kernel ever sees these
  STREAM: DurableObjectNamespace; // the durable log
  LOADER: WorkerLoader; // runs confined config-worker code
  AI: Ai;
  BROWSER: BrowserWorker;
  FILES_BUCKET: R2Bucket;
  KV: KVNamespace;
  EMAIL: SendEmailBinding;
  // ...egress fetcher, secrets DO, etc.
}

export default {
  async fetch(req: Request, env: KernelEnv): Promise<Response> {
    const { projectId, request } = resolveIngress(req); // hostname -> project (kernel)
    const itx = makeItx(projectId, env); // wrap bindings as capabilities
    // run the project's confined worker with ONLY itx — raw bindings never leak in:
    return env.LOADER.run(projectId, { itx, request });
  },
};
```

The kernel is the ~6k-LOC floor: ingress, the log, the capability resolver, the
egress door, identity/addressing, and `WorkerLoader`-based confined execution. It
_holds_ `env.AI` and hands out `itx.ai`.

## Sketch B — a user project: only `itx`, no bindings (already how it works)

```ts
// a user's /repos/config/worker.ts — confined; holds NO Cloudflare bindings
import { IterateWorkerEntrypoint } from "iterate/sdk";

export default class extends IterateWorkerEntrypoint {
  async fetch(req: Request) {
    const answer = await this.itx.ai.run("llama-3", { prompt: "hi" }); // capability, not env.AI
    return Response.json(answer);
  }
  async processEvent(event) {
    /* fold the log via this.itx */
  }
}
```

## Sketch C — the OS as a project: same shape, plus one privileged capability

```ts
// apps/os/worker.ts — iterate's control plane, but it's just a project's config worker
import { IterateWorkerEntrypoint } from "iterate/sdk";
import { Dashboard } from "iterate/first-party/dashboard";
import { BillingProcessor } from "iterate/first-party/billing";

export default class OsProject extends IterateWorkerEntrypoint {
  #dashboard = Dashboard.create(this.itx);
  #billing = BillingProcessor.create(this.itx);

  async fetch(req: Request) {
    return this.#dashboard.fetch(req); // serve the dashboard over normal project fetch
  }

  async processEvent(event) {
    // The ONE thing ordinary projects can't do: itx.operator — a privileged
    // capability the kernel grants ONLY to the OS project. Not raw bindings.
    if (event.type === "signup/requested") {
      await this.itx.operator.projects.create({ slug: event.slug }); // "sudo": birth another project
    }
    await this.#billing.processEvent(event); // aggregate cost across the fleet (operator cap)
  }
}
```

The OS dashboard, agent, and integrations are all **userspace** here — they use
`itx.*` like any project. The OS's _only_ superpower is `itx.operator.*`.

## Sketch D — what makes the OS special is exactly ONE grant

```ts
// inside the kernel's makeItx()
const OPERATORS = new Set(["os"]); // hosted: iterate's own; self-hosted: you

function makeItx(projectId: string, env: KernelEnv): Itx {
  const itx = baseItx(projectId, env); // ai, files, kv, streams, egress, secrets…
  if (OPERATORS.has(projectId)) {
    itx.operator = makeOperatorCapability(env); // create projects · fleet billing · leased OAuth roots
  }
  return itx;
}
```

The privilege is one conditional grant, not a fork of the codebase. `itx.operator`
is a controlled, audited exception to R1 (a project can't touch another) — the
control plane. **Hosted:** iterate holds it. **Self-hosted:** you hold it. That's
Axis 2 (deployment), expressed as a single capability.

---

## Why this is less hardcore than it sounds — the incremental path

We do **not** rewrite into a kernel package on day one. The direction is reached
step by step, each step shippable:

1. **Built-ins → mounts** (already the plan) — the mechanism. `kv` first.
2. **Move iterate's features to userspace packages** that consume `itx` — partly
   done (review bot #2223, starter apps). Agent + integrations next.
3. **Add `itx.operator`** — identify the handful of genuinely cross-project
   privileges (provision, fleet-billing, leased-OAuth roots) and expose them as one
   explicit capability granted to the OS project. Small, new, additive.
4. **Extract the kernel from `ProjectDurableObject`** — factor out streams / egress
   / capability-host / auth, one subsystem at a time. The big lift, done gradually;
   `ProjectDurableObject` shrinks toward the ~6k kernel as features leave for
   userspace.

At no point is there a big-bang rewrite. Model 3 is the _destination_; each cut on
the `TODO.md` list is a step toward it.

## The one genuinely-privileged residue

After all this, exactly two things are privileged, and neither is diffuse:

- **the kernel** (holds raw bindings, enforces the walls), and
- **`itx.operator`** (the control plane — provision, fleet billing, and the
  un-mintable leased-OAuth _root_ secrets = the moat).

Everything else — agent, integrations, dashboard, starter apps, user apps — is
userspace consuming `itx`.

---
status: ready
size: large
---

# AI cost controls and attribution

Design and code sketch approved in Plannotator rev 8 on 2026-09-07. Implementation has not started. Agreed: one OpenAI project, account-level CF rules in TypeScript, trusted attribution, explicit credential ownership, and durable budget pauses. Remaining: implementation, interception tests, gateway validation, credential migration, and rollout.

- [x] Agree scope, limits, attribution, and proposed code changes. *Approved in Plannotator rev 8; source feedback in `tmp.ignoreme/ai-cost-grill/decisions/`.*
- [ ] Add typed production/development rule lists and serialized account-level application with diff/readback.
- [ ] Thread trusted attribution through agents, compaction, egress, and approved/released calls; keep retry attribution stable.
- [ ] Confirm eventOffset cardinality suitability before enabling it; ship other fields if unresolved.
- [ ] Model budget responses as typed results and durable settlement events; add explicit retry and visible UI state.
- [ ] Model credential ownership and keep customer-paid provider calls outside company budgets.
- [ ] Extend interception to exercise prepared headers and real response decoding; prove attribution, pause/recovery, and UI behavior.
- [ ] Run a small live preview proof of actual CF counters, response shape, windows, and rule-update behavior; remove temporary rules.
- [ ] Migrate company-key copies/direct callers, introduce company-owned credentials, and retire the old key once covered routes are verified.
- [ ] Roll out production enforcement and verify the OpenAI org backstop.

Session: `01a07b03-100a-7803-ba3f-caed48046317` (Codex).
Related PR: [#2553 — source.script provenance](https://github.com/iterate/iterate/pull/2553).

## Proposed code changes

Approved implementation sketch. New names below are proposed; existing files and call paths were inspected. The snippets are illustrative and have not been applied or typechecked.

### 1. A small TypeScript rule file

New `apps/os/scripts/ai-gateway-budget-rules.ts`. Three rules per gateway, regardless of project count. Production and dev/preview use their existing separate accounts.

Cloudflare does export the type: [`AIGatewayUpdateParams.SpendLimits.Rule`](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/ai-gateway/ai-gateway.ts). Use that from a pinned published `cloudflare` SDK version containing the field. It is not currently a direct dependency here; adding a type-only dependency is simpler than generating a second schema. If the published version lags the source, use the repo's `eslint-plugin-codegen` cache with pinned upstream OpenAPI/source input, not an unversioned scrape of the rendered docs.

```ts
import type { AIGatewayUpdateParams } from "cloudflare/resources/ai-gateway/ai-gateway";
type SpendRule = AIGatewayUpdateParams.SpendLimits.Rule;

export function productionRules(): SpendRule[] {
  return [
    {
      id: "iterate-gateway-daily", enabled: true,
      limitType: "cost", limit: 30, window: 86_400, technique: "sliding",
    },
    {
      id: "iterate-project-daily", enabled: true,
      limitType: "cost", limit: 10, window: 86_400, technique: "sliding",
      metadata: {
        environment: { mode: "partition" },
        projectId: { mode: "partition" },
      },
    },
    {
      id: "iterate-stream-hourly", enabled: true,
      limitType: "cost", limit: 3, window: 3_600, technique: "sliding",
      metadata: {
        environment: { mode: "partition" },
        projectId: { mode: "partition" },
        streamPath: { mode: "partition" },
      },
    },
  ];
}

export function developmentRules(): SpendRule[] {
  return [
    {
      id: "iterate-gateway-daily", enabled: true,
      limitType: "cost", limit: 10, window: 86_400, technique: "sliding",
    },
    {
      id: "iterate-project-daily", enabled: true,
      limitType: "cost", limit: 10, window: 86_400, technique: "sliding",
      metadata: {
        environment: { mode: "partition" },
        projectId: { mode: "partition" },
      },
    },
    {
      id: "iterate-stream-hourly", enabled: true,
      limitType: "cost", limit: 3, window: 3_600, technique: "sliding",
      metadata: {
        environment: { mode: "partition" },
        projectId: { mode: "partition" },
        streamPath: { mode: "partition" },
      },
    },
  ];
}
```

Pure data in separate functions; repetition makes each account's policy readable independently. One entry point chooses `account === "production" ? productionRules() : developmentRules()`.

These are the actual [CF API field names](https://developers.cloudflare.com/api/resources/ai_gateway/methods/update/). The sketch expresses windows in seconds; verify that interpretation against dashboard readback before applying real limits because the generated API reference only says `number`.

New `apps/os/scripts/ai-gateway-budgets.ts`, using the existing `resolveEnvContext` account-scoped API client:

```ts
const ctx = await resolveEnvContext({ envs, dopplerProject: "os", env });
const path = `/ai-gateway/gateways/${gatewayId}`;
const current = await ctx.cf<Gateway>(path);
const rules = account === "production" ? productionRules() : developmentRules();
const desired = {
  ...gatewayUpdateFields(current), // Writable fields only; preserve other settings.
  spend_limits: { enabled: true, rules },
};

printBudgetDiff(current.spend_limits, desired.spend_limits);
if (apply) {
  await ctx.cf(path, { method: "PUT", body: JSON.stringify(desired) });
  const actual = await ctx.cf<Gateway>(path);
  assertBudgetRulesMatch(actual.spend_limits, desired.spend_limits);
}
```

`Gateway`, `gatewayUpdateFields`, `printBudgetDiff`, and `assertBudgetRulesMatch` are proposed typed implementation pieces. The command refuses to replace unexpected unowned rules without incorporating them into reviewed configuration. One serialized account-level CI job owns changes; ordinary Worker/preview deploys do not run it. Account selection comes from `envs.ts`. Preserve stable IDs and test whether updates reset counters.

### 2. One trusted attribution value at both AI entry points

New `apps/os/src/domains/agents/ai-cost-attribution.ts`:

```ts
type AiCostAttribution = {
  environment: string;
  projectId: string;
  projectSlug: string;
  stream: { path: string; eventOffset: number | undefined } | null;
};

export function aiGatewayMetadata(
  attribution: AiCostAttribution,
  includeEventOffset: boolean,
) {
  return {
    environment: attribution.environment,
    projectId: attribution.projectId,
    projectSlug: attribution.projectSlug,
    streamPath: attribution.stream?.path,
    eventOffset: includeEventOffset
      ? attribution.stream?.eventOffset
      : undefined,
  };
}
```

`JSON.stringify` drops the undefined values; no conditional spreads needed. An offset of zero remains zero.

All inputs come from the host: deployment identity, project directory, and executing stream. No attribution from caller-controlled `cf-aig-metadata`, `x-iterate-agent`, or `x-iterate-sandbox`. A missing required environment/project identity is a configuration defect; missing stream context is an explicit non-stream call. Project slug is a readable label, never a budget key. No per-call project-directory network lookup: use the existing project identity path and refresh its label on rename.

`includeEventOffset` is a rollout configuration, initially false until cardinality suitability is confirmed. No hidden fallback and no invented offsets. [CF documents identifiers and numbers](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/), but no explicit distinct-value ceiling. Four fields can ship independently. Test missing stream metadata against the actual partition rule; non-stream calls must still hit project and gateway limits.

In `workers-ai-transport.ts`, add required metadata to the production transport input and send it alongside existing headers:

```diff
 const headers: Record<string, string> = {
   authorization: `Bearer ${transport.openaiApiKey}`,
+  "cf-aig-metadata": JSON.stringify(input.metadata),
   "cf-aig-collect-log": "true",
   "cf-aig-collect-log-payload": "true",
   "content-type": "application/json",
 };
```

`processor-facet-durable-object.ts` supplies trusted project/environment identity; `agent-llm-request.ts` supplies the request's stream and attribution offset. Thread the value through `agent-host.ts` and `runWorkersAiAttempt`, including compaction calls. The non-BYOK `AI.run` branch also needs an explicit gateway and metadata in its binding options; today it does not have them.

In `openai-ai-gateway-egress.ts`, replace the current `{ projectId, source, caller }` metadata with that same host-built shape. In `project-durable-object.ts`, preserve the `StreamContext` that already arrives at the approval gate but is currently dropped before `#egress`:

```diff
-async #egress(request: Request): Promise<Response>
+async #egress(request: Request, streamContext: StreamContext): Promise<Response>
```

Thread it through both immediate and approved/released request paths, then into `#egressOpenAiViaAiGateway`. For a script context, use its home stream and `scriptRunRequestedEventOffset`; a scope-only call has a path but no offset. Reuse [PR #2553](https://github.com/iterate/iterate/pull/2553)'s host provenance model; do not trust arbitrary event `source.processor` claims. Its mounted-alias context gap needs a fix or an explicit unattributed classification, not a guessed parent.

### 3. Preserve the original operation offset through retries

The current reducer creates a new `llm-request-requested` event on every retry. Just sending `open.requestedAtOffset` would violate our agreed “same attribution across retries.”

Add `costEventOffset` to the reduced open-request state and a nullable value to pending-trigger state in `agent-processor-contract.ts` / `agent-prompt-fold.ts`:

```ts
// On a fresh external/agent-loop trigger:
pendingTrigger.costEventOffset = null;

// Reducing llm-request-requested:
openRequest.costEventOffset =
  pendingTrigger.costEventOffset === null
    ? event.offset
    : pendingTrigger.costEventOffset;

// On a retry-worthy failure:
pendingTrigger.costEventOffset = openRequest.costEventOffset;

// Calling the transport:
metadata.eventOffset = openRequest.costEventOffset;
```

These snippets illustrate branches of the existing pure reducer, not imperative mutations to add verbatim. This is derived from durable events and therefore survives eviction/replay. New operations get new attribution; retries share it. Actual request settlement still uses its own `requestedAtOffset`. No new global task ID or cross-stream budget inheritance.

### 4. A budget stop is a terminal event, not a generic failure

Extend the existing `llm-request-settled.result` union in `agent-processor-contract.ts` with a distinct result, rather than introducing a second competing terminal event:

```ts
z.object({
  status: z.literal("budget-exhausted"),
  budget: z.object({
    provider: z.string(),
    ruleId: z.string().nullable(),
    resetsAt: z.string().nullable(),
  }),
})
```

`ruleId` and `resetsAt` are null unless supported by the actual response. Budget exhaustion is an expected transport result, not an exception:

```ts
type AiAttemptResult =
  | { status: "succeeded"; completion: WorkersAiCompletion }
  | { status: "budget-exhausted"; budget: BudgetDetails }
  | { status: "rate-limited"; retryAfterMs: number | null };

// In workers-ai-transport.ts, after obtaining a Response:
const result = await decodeGatewayResponse(response);
// Decoder uses confirmed response codes/body shapes. Never "429 means budget".
if (result.status !== "succeeded") return result;
return { status: "succeeded", completion: await drainCompletion(result.response) };
```

`decodeGatewayResponse`, `BudgetDetails`, and `drainCompletion` name proposed pieces; the current SSE drain remains underneath. The decoder distinguishes known budget blocks, ordinary rate limiting, success, and malformed/unexpected failures. Transport faults may still throw. A low-limit real-gateway response establishes the fixture and parser, rather than inventing a CF error string.

In `agent-llm-request.ts`, handle the result before generic exception handling:

```ts
const result = await this.attempt(input);
if (result.status === "budget-exhausted") {
  await appendUnlessLostIdempotencyRace(args.append, [{
    type: "events.iterate.com/agent/llm-request-settled",
    payload: {
      requestOffset,
      durationMs: Math.max(0, this.#host.now() - startedAtMs),
      result: { status: "budget-exhausted", budget: result.budget },
    },
    idempotencyKey: this.#host.idempotencyKey(`settle/${requestOffset}`),
  }]);
  return;
}
// rate-limited -> existing bounded retry scheduling, with its own classification.
// succeeded -> existing chunk/assistant/token-usage settlement.
```

Use the existing settlement fence: a concurrent cancellation/recovery cannot create a second terminal fact. The reducer closes the request and creates a typed budget pause without incrementing the failure count or scheduling retries. Expected exhaustion does not emit `stream/error-occurred`.

The current turn loop auto-resumes ordinary pauses on external messages. Add a typed distinction so this cannot clear a budget pause. Explicit retry appends `agent/resumed` targeting the budget-pause offset, so a stale click cannot clear a newer pause. The next request still goes through CF; if it remains over budget, it pauses again. Restart, recovery, new messages, and self-generated events must not automatically resume it.

Update the agent UI reducer/presentation to show “Budget exhausted” and an explicit retry action, plus known rule/reset details. Non-stream egress returns a structured budget error to its caller; a script's rejection should flow through its own journal settlement instead of pretending it was the parent agent's LLM request. This needs corresponding script-result/UI classification for a visible budget stop.

### 5. Credential ownership is explicit; future billing is separate

Yes, add an owner to the trusted credential selection, rather than infer ownership from the presence of an Authorization header or a Secret DO path:

```ts
type AiCredential =
  | { owner: "iterate"; platformKey: SecretString }
  | { owner: "customer"; projectId: string; secretPath: string };
```

`SecretString` here stands for the repo's existing secret wrapper. The trusted resolver supplies this union; callers cannot claim `owner: "customer"` while using the company key. Existing company-key copies in Secret DOs need migration, not blind classification as customer-owned.

**Proposed routing:** keep the existing company gateway exclusively for Iterate-owned credentials. If customer-owned credentials are gateway-routed, use a separate `customer-byok` gateway per account, without the company spend rules. Creating it is only necessary when moving customer-key requests through it. This keeps company limits off customer-paid provider usage and preserves all five attribution slots. Customer requests remain explicit and never get upgraded to the platform key.

This is equivalent to selecting by ownership before the gateway, rather than filtering a sixth metadata property inside CF. Adding `keyOwner` to the same gateway's rules is also possible, but would require dropping one of the five fields—I'd drop the redundant slug before losing stable IDs. The sketch prefers separate gateways so we keep the requested metadata intact. Never use separate gateways per customer/project; the split is just credential ownership.

The owner identifies who pays the **provider**, not whether we charge the customer. Future usage billing could charge a customer while the provider key remains Iterate-owned. The current attribution supplies the useful join keys: environment, stable project ID, stream, event, provider/model, and measured usage. `projectSlug` is display-only.

For invoice-quality billing later we would also need a durable per-provider-attempt usage record, unique request/attempt ID, cached-token and tool charges, pricing version, project-to-billing-account mapping, and reconciliation/adjustments. **Do not deduplicate invoices on eventOffset:** retries share that attribution but can each incur cost. Gateway logs and estimated spend are useful evidence, not the authoritative customer ledger. Existing agent token-usage events help, but do not cover every egress path. No billing ledger or payment integration in this change; this design leaves room for one without conflating company cost with customer charges.

### 6. Interception drives most acceptance tests

Yes—your five cases should mostly be deterministic e2e/spec tests using the existing interception machinery. There is one real gap: today's `fixture.interceptAi` receives parsed messages and returns text/usage **before** gateway headers and HTTP decoding. `project.egress.intercept` is also before credential substitution/gateway preparation. Neither currently proves wire headers or the budget-response parser.

Proposed small extension: keep the existing live interceptor lifecycle, add an explicitly intercepted gateway-format lane that receives the **same prepared request** used by the real gateway adapter (before attaching real credentials), and returns an HTTP-shaped fixture through the **same response decoder**. Real `openai/*` models remain non-interceptable; the new lane stays under `intercepted/*`. Do not create a second metadata builder or budget parser for tests.

```ts
// Proposed fixture helper/API extension, not available today.
await using fixture = await helpers.createFixture("ai-budget");
let attempts = 0;
await using interception = await fixture.interceptAiGateway(async (request) => {
  attempts += 1;
  expect(JSON.parse(request.headers["cf-aig-metadata"])).toMatchObject({
    projectId: fixture.projectId,
    streamPath: agent.path,
  });
  // HTTP status/headers/body captured from a tiny real-gateway budget test.
  return gatewayBudgetExceededFixture;
});
const agent = await fixture.createAgent({ model: "intercepted/gateway-budget" });
await page.goto(agent.webUrl);
await page.getByPlaceholder("Message this agent").fill("Hello");
await page.getByRole("button", { name: "Send message" }).click();
await expect(page.getByText("Budget exhausted", { exact: true })).toBeVisible();
await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
// Assert one durable budget settlement, and no scheduled retry obligation.
// Drive new input + DO restart/replay; verify attempts remains 1.
// Swap interceptor response to success, click Retry, verify completion.
```

The helper names/options above are the proposed ergonomic surface. Exact event/offset assertions use the existing itx stream reads and scheduler state; prove quiescence/recovery rather than merely asserting the call count immediately after a render. Cover headers, offset accuracy through retries, user text/actions, two project/stream identities, and customer/Iterate credential selection. A binding-level integration test with dummy credentials verifies the final actual `gateway.run` header envelope too.

The small live preview smoke is then only for what an interceptor cannot establish: CF honors those headers on our binding, prices the model, partitions the real counters, and blocks at the configured rule. Record the actual response fixture; test production parsing/UI with it for free. Confirm reset/update semantics, then remove temporary rules. No large billed test matrix.

### 7. Close remaining company-key bypasses

- Inventory company-key copies in Secret DOs and direct scripts. Migrate to gateway-backed access before retiring Rahul's key; Doppler updates do not rotate stored copies.
- JSON egress is routed today; voice, multipart, and WebSocket calls need supported gateway adapters or an explicit unavailable result for company-funded access. Never silently fall back to direct provider calls.
- Update the direct sound-generation tool and voice secret bootstrap where they use company credentials. Verify each covered route before switching its credentials.
- Cover fallback/non-OpenAI lanes too; the OpenAI org limit cannot cover other providers' bills.

### Expected change footprint

| Area | Files |
| --- | --- |
| Rule configuration/application | Two new scripts above; CF SDK types; account-level CI job and package script |
| Trusted metadata | New attribution module; `processor-facet-durable-object.ts`, `agent-host.ts`, `agent-llm-request.ts`, `workers-ai-transport.ts` |
| Egress context/coverage | `project-durable-object.ts`, `openai-ai-gateway-egress.ts`, trusted credential owner, voice/script callers |
| Durable pause and retry | `agent-processor-contract.ts`, `agent-prompt-fold.ts`, `agent-turn-loop.ts`, script settlement handling |
| Presentation and verification | Agent UI reducer/actions; `model-interception.ts` + fixture extension; existing tests plus small preview smoke |

## Decisions

1. Keep this independent of event names: attribute requests using stable runtime context.
2. Send `environment`, `projectId`, `projectSlug`, `streamPath`; add `eventOffset` only after confirming high-cardinality metadata is suitable. The documented five-entry limit is satisfied, but no explicit distinct-value guarantee was found. Validate the actual binding and logged values before rollout; omit offset if unresolved. This does not block the other controls.
3. Keep one OpenAI project with company-owned credentials; Cloudflare enforces granular budgets and the OpenAI org hard limit is the shared final backstop. Cover company-paid app routes so bypasses cannot silently evade gateway rules.
4. Attribute each paid operation to its directly triggering event on its own stream; retries retain that offset. Trace ancestors through journal source links. Use environment + projectId + streamPath for stream budgets; projectSlug is a label. Offset is diagnostic metadata, not a budget partition. Calls without stream context have explicit non-stream attribution and no fabricated offset.

5. Initial rolling limits: production gateway $30/24h; shared dev/preview gateway $10/24h; each environment/project $10/24h; each environment/project/stream $3/hour. OpenAI org backstop $1,000/month. These are starting controls, to be adjusted from attributed usage.

6. Budget exhaustion is a durable stream event, visible in the agent UI, which pauses affected work. Resume through an explicit retry after the budget permits it. No budget retry loop or provider fallback; ordinary rate limits stay distinct. Non-stream callers receive a structured error and operational telemetry.

7. Own rules in versioned TypeScript, applied by one serialized account-level command/CI job per account. Preview deployments do not own shared rules. Inspect diff, preserve unrelated settings and stable rule IDs, apply, and verify readback. Prove attribution, isolation, pause events, replay, explicit resumption, and route coverage on preview before production enforcement; remove temporary test rules. Resolve rule-update counter semantics and eventOffset suitability before relying on them.

8. Implementation refinements: separate pure-data production/development rule functions with CF SDK types; expected budget responses use a result union; explicit credential ownership selects the company-budget boundary; interception drives deterministic e2e/spec proof and a small live smoke validates CF itself.
9. Future customer usage billing can reuse stable attribution and usage evidence, but needs its own durable per-attempt ledger and reconciliation; retry-shared event offsets are not invoice deduplication IDs.


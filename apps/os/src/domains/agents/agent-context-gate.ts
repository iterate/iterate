// The append-time gate for agent context: ONE server-side validation and
// stamping point, applied where every itx append funnels through the OS
// worker (StreamRpcTarget.append / appendIfStreamId, and therefore also
// AgentRpcTarget.append, message/ask/addFiles, and the web UI's raw
// composer). Provenance is a fact about the authenticated caller, never a
// claim in the payload: the gate decides what each caller class may say
// about itself, stamps the `actor` from the caller's own authority, and
// ignores or rejects everything else. `model` and `platform` actors are
// inexpressible through any external path — only platform code, which never
// passes this gate, writes them.
//
// Only `agents/context-added` events are touched; every other event type
// passes through untouched (streams accept raw appends by design).

import { z } from "zod";
import { userPrincipalOf, type ItxAuth } from "../../auth.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";

const AGENT_CONTEXT_ADDED_TYPE = "events.iterate.com/agents/context-added";

/**
 * The caller classes the gate distinguishes — everything the rpc layer
 * already knows about a caller:
 *
 * - `trusted` — platform-internal code and admin tooling; no gating.
 * - `user` — an authenticated human session (browser, MCP client, proxied
 *   project-app session). Always stamped as itself.
 * - `agent` — an itx scoped to an agent path: the agent's own scripts and
 *   agents messaging other agents.
 * - `worker` — project-authored automation: a dynamic worker's itx at a
 *   non-agent scope (the config worker), or the project's own machine
 *   credential (a remote app holding the born project API key).
 */
export type AgentContextCaller =
  | { tier: "trusted" }
  | { tier: "user"; userId: string | undefined }
  | { tier: "agent"; scopePath: string }
  | { tier: "worker" };

/**
 * Classify a caller from its authority plus the itx scope its handle was
 * reached through. External-credential callers classify by credential
 * (`resolveItxAuth` mints the principal prefixes matched here); internal
 * ones by scope — platform code constructs stream targets without a scope,
 * while dynamic workers and agent scripts always carry the scope their itx
 * was minted for (callers do not choose their own scope).
 */
export function classifyAgentContextCaller(input: {
  auth: ItxAuth;
  scopePath: string | undefined;
}): AgentContextCaller {
  const { auth, scopePath } = input;
  if (auth.origin === "external") {
    if (auth.isAdmin()) return { tier: "trusted" };
    // The project's own machine credential: project-authored automation,
    // the same trust tier as the project's worker.
    if (auth.principal.startsWith("project-secret:")) return { tier: "worker" };
    const user = userPrincipalOf(auth);
    if (user !== undefined) return { tier: "user", userId: user.userId };
    // A proxied project-app session acts AS the user its token names
    // (principal shape: "project-app-session:<userId>@<projectId>").
    if (auth.principal.startsWith("project-app-session:")) {
      const userId = auth.principal.slice("project-app-session:".length).split("@")[0];
      return { tier: "user", userId: userId || undefined };
    }
    // Any other external credential fails DOWN: a user with no richer
    // identity than its principal string.
    return { tier: "user", userId: auth.principal || undefined };
  }
  if (scopePath !== undefined && scopePath.startsWith("/agents/")) {
    return { tier: "agent", scopePath };
  }
  if (scopePath !== undefined) return { tier: "worker" };
  return { tier: "trusted" };
}

/**
 * Gate a batch about to be appended: context-added payloads are validated
 * against the caller's tier, their `actor` stamped from the caller, and the
 * result re-validated against the contract's payload schema (one authority
 * for shapes). Other event types pass through untouched. Throws on a claim
 * the caller may not make — a loud programming error at the caller, never a
 * silently rewritten meaning.
 */
export function gateAgentContextEvents<Event extends { type: string; payload?: unknown }>(input: {
  events: readonly Event[];
  caller: AgentContextCaller;
}): Event[] {
  const { caller } = input;
  if (caller.tier === "trusted") return [...input.events];
  return input.events.map((event) => {
    if (event.type !== AGENT_CONTEXT_ADDED_TYPE) return event;
    const stamped = stampContextPayload({ caller, payload: event.payload });
    const parsed =
      AgentProcessorContract.events[AGENT_CONTEXT_ADDED_TYPE].payloadSchema.safeParse(stamped);
    if (!parsed.success) {
      throw new Error(`invalid agents/context-added payload: ${parsed.error.message}`);
    }
    return { ...event, payload: stamped };
  });
}

/** The claim surface the gate reads before stamping. Loose on purpose: tier
 * rules decide what survives; the final contract parse owns exact shapes. */
const ContextClaim = z.looseObject({
  actor: z.looseObject({ type: z.string() }).optional(),
  compaction: z.unknown().optional(),
  key: z.unknown().optional(),
  kind: z.unknown().optional(),
  llmRequestOffset: z.unknown().optional(),
  role: z.unknown().optional(),
});

function stampContextPayload(input: { caller: AgentContextCaller; payload: unknown }): unknown {
  const claim = ContextClaim.safeParse(input.payload);
  if (!claim.success) {
    throw new Error("agents/context-added payload must be an object");
  }
  const payload = claim.data;
  const caller = input.caller;
  // Inexpressible through any external path, regardless of tier: platform
  // authorship, model output identity, and the compaction rewrite.
  for (const [field, present] of [
    ["compaction", payload.compaction !== undefined],
    ["llmRequestOffset", payload.llmRequestOffset !== undefined],
    ["actor.model/platform", payload.actor?.type === "model" || payload.actor?.type === "platform"],
  ] as const) {
    if (present) {
      throw new Error(`agents/context-added: ${field} is platform-authored and cannot be appended`);
    }
  }
  // The stored role is not a write surface: a deployed older client may
  // still send one, but it never survives the gate — the stamped actor is
  // what the role derives from.
  const { actor: claimedActor, kind: _kind, key, role: _role, ...rest } = payload;

  if (caller.tier === "user" || caller.tier === "agent") {
    if (key !== undefined) {
      throw new Error(
        "agents/context-added: keyed sections come from project owners (the config worker or the platform)",
      );
    }
    if (caller.tier === "user") {
      const origin = claimedActor?.type === "user" && claimedActor.origin === "mcp" ? "mcp" : "web";
      return {
        ...rest,
        actor: {
          type: "user",
          origin,
          ...(caller.userId === undefined ? {} : { userId: caller.userId }),
        },
      };
    }
    // Agent scope: script and agent self-attribution stay inside the same
    // trust tier (only the caller knows its executionId); everything else —
    // including an agent-path claim naming some OTHER agent — is stamped
    // with the authenticated scope.
    const actor =
      claimedActor?.type === "script" ? claimedActor : { type: "agent", path: caller.scopePath };
    return { ...rest, actor };
  }

  // Worker tier. A worker may name itself and may relay channel-native
  // identity (channel actors derive user role — the floor — so the claim
  // grants no precedence; its attestation is worth exactly "the project's
  // code said so"). It may NOT claim to be an authenticated user: the user
  // actor carries the OS principal device notifications address.
  if (claimedActor?.type === "user") {
    throw new Error(
      "agents/context-added: project code cannot claim to be a signed-in user; the user actor is stamped from an authenticated session",
    );
  }
  const workerActor =
    claimedActor !== undefined &&
    ["worker", "integration", "slack", "telegram", "email", "github"].includes(claimedActor.type)
      ? claimedActor
      : { type: "worker", name: "project-worker" };
  if (key !== undefined) {
    // Keyed content is the section shape; content this shape does not carry
    // (refs, files, policies) does not survive — sections are standing
    // instructions, nothing else.
    const { content } = rest as { content?: unknown };
    return { kind: "section", key, content, actor: workerActor };
  }
  return { ...rest, actor: workerActor };
}

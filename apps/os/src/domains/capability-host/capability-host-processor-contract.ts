// The capability-host processor CONTRACT: a tiny dynamic capability table
// plus the script-run-requested / script-run-settled promise vocabulary —
// the reference shape for "one terminal event per obligation, named
// `-settled`, with a result union in the payload".
//
// Self-contained: state schema, events, consumes/emits, deps — schemas are
// spelled INLINE in the contract; the ONE schema the contract uses twice (the
// birth certificate, in the state and in the `created` event) is a hoisted
// function below the contract, so the contract still opens the file. The
// capability payload shapes are pinned (`satisfies z.ZodType<...>`) to the
// hand-written types in `./types.ts`, which are the itx-facing contract for
// `provideCapability` / `revokeCapability`.
//
// No synthetic ids for mounts: a mount's identity is `providedAtOffset`, the
// stream offset of the `capability-provided` event that created it. Script
// executions DO carry a caller-supplied `executionId` — the requester lives
// on another stream (an agent stream, a public runScript call), so this
// stream's offsets cannot name the obligation for it; the id is the
// cross-stream correlation key and every settle idempotency key derives from
// it.

import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import { ItxExpression, ItxExpressionStep } from "../../itx/expression.ts";
import type {
  CapabilityProvidedPayload,
  CapabilityRecord,
  RevokeCapabilityInput,
} from "./types.ts";
import type { PreambleEntry, RetainedScriptResult } from "./capability-host-preamble.ts";
import { ScriptExecutionSettlement } from "./script-execution-settlement.ts";

export const CapabilityHostProcessorContract = defineProcessorContract({
  slug: "capability-host",
  // 0.6.0: two parallel 0.5.0 claims merged — main's provider pagers and this
  // branch's preamble (preamble-set/removed events, retained script results).
  // 0.7.0: void-returning successes retain a payload-free "done" row, so
  // every settled script keeps an offset handle in `results`; re-reduces
  // from offset 0.
  // 0.8.0: retained rows carry `scriptOffset` (the run's script-run-requested
  // offset) — the handle previousScriptHelper demands; re-reduces from 0.
  version: "0.8.0",
  description: "A tiny dynamic capability table and script execution stream.",
  stateSchema: z.object({
    birthCertificate: capabilityHostBirthCertificateSchema()
      .nullable()
      .default(null)
      .meta({
        description:
          "Existence marker plus the scope's durable resolution policy: null until " +
          "capability-host/created reduces. No capability reads, mounts, or script runs happen " +
          "before it.",
      }),
    capabilityProviderPagers: z
      .array(
        z.strictObject({
          connectedAtOffset: z.number().int().nonnegative().meta({
            description:
              "The Pager's identity: the stream offset of the capability-provider-pager-connected event.",
          }),
        }),
      )
      .default([])
      .meta({
        description:
          "Client-given hibernatable return channels currently connected to this host. " +
          "One Pager may own any number of live capability mounts.",
      }),
    capabilities: z
      .array(
        z
          .discriminatedUnion("type", [
            z.strictObject({
              type: z.literal("live").meta({
                description:
                  "A Pager-backed live mount: the client gives the host a hibernatable return " +
                  "channel so it can Page the provider relay after releasing ordinary RPC references. " +
                  'Calls fail "offline" when that Pager disconnects; only the record is durable.',
              }),
              path: z
                .array(z.string())
                .meta({ description: 'Mount point as path segments, e.g. ["tools", "weather"].' }),
              providerPager: z
                .strictObject({
                  connectedAtOffset: z.number().int().nonnegative(),
                })
                .meta({
                  description:
                    "The capability-provider-pager-connected event for the client-given Pager " +
                    "that can return this mount's provider. It contains no socket id or RPC stub.",
                }),
              providedAtOffset: z
                .number()
                .int()
                .nonnegative()
                .meta({
                  description:
                    "The mount's identity: the stream offset of the capability-provided event " +
                    "that created it. Handles revoke exactly the mount they received with it.",
                }),
              instructions: z
                .string()
                .optional()
                .meta({
                  description:
                    "Prose for the model: what the capability does and how to call it " +
                    "(surfaced by __describe and itx.docs).",
                }),
              types: z
                .string()
                .optional()
                .meta({
                  description:
                    "The mount's Capability Type Declaration — TypeScript declaration text " +
                    "describing the mounted value; read by itx.docs and the script typecheck gate.",
                }),
              flattenNestedPaths: z
                .boolean()
                .optional()
                .meta({
                  description:
                    "True when the provider is a dispatcher: any dotted call under the mount " +
                    "arrives as ONE invokeCapability({ path, args }) instead of property traversal.",
                }),
            }),
            z.strictObject({
              type: z.literal("itx-call").meta({
                description:
                  "A durable mount: the recorded expression is re-evaluated against this " +
                  "scope's own itx on every call — no live connection is held.",
              }),
              path: z
                .array(z.string())
                .meta({ description: 'Mount point as path segments, e.g. ["pets"].' }),
              providedAtOffset: z
                .number()
                .int()
                .nonnegative()
                .meta({
                  description:
                    "The mount's identity: the stream offset of the capability-provided event " +
                    "that created it. Handles revoke exactly the mount they received with it.",
                }),
              expression: z.array(ItxExpressionStep).meta({
                description:
                  "The recipe: property names and [method, ...args] steps walked over this " +
                  "scope's itx. The stream stores the NAME of the capability, never captured " +
                  "authority.",
              }),
              instructions: z
                .string()
                .optional()
                .meta({
                  description:
                    "Prose for the model: what the capability does and how to call it " +
                    "(surfaced by __describe and itx.docs).",
                }),
              types: z
                .string()
                .optional()
                .meta({
                  description:
                    "The mount's Capability Type Declaration — TypeScript declaration text " +
                    "describing the mounted value; read by itx.docs and the script typecheck gate.",
                }),
              flattenNestedPaths: z
                .boolean()
                .optional()
                .meta({
                  description:
                    "True when the evaluated provider is a dispatcher: any dotted call under the " +
                    "mount arrives as ONE invokeCapability({ path, args }) instead of property " +
                    "traversal.",
                }),
            }),
          ])
          .meta({
            description:
              "One reduced capability-table row: the capability-provided payload plus the " +
              "providing event's offset.",
          }) satisfies z.ZodType<CapabilityRecord, unknown>,
      )
      .default([])
      .meta({
        description:
          "The capability table: one row per mount point (a re-provide at the same path " +
          "replaces the row). Reads resolve the longest matching prefix; a miss follows the " +
          "birth certificate's fallback expression.",
      }),
    scriptExecutions: z
      .record(
        z.string().meta({ description: "The caller-supplied executionId." }),
        z.object({
          status: z.enum(["requested", "started"]).meta({
            description:
              "requested = no attempt has begun (provably never ran, safe to start late); " +
              "started = an attempt began, so the script may have half-executed — an " +
              "incarnation dying here settles it as a failure, never re-runs it.",
          }),
          code: z.string().meta({
            description:
              "The script source, carried in state so an attempt can start from the reduced " +
              "state alone (recovery never re-reads the request event).",
          }),
          requestedAtOffset: z
            .number()
            .int()
            .nonnegative()
            .meta({
              description:
                "The exact script-run-requested event carrying this code; retained so downstream " +
                "effects can point back to their durable source.",
            }),
          expiresAt: z
            .number()
            .int()
            .positive()
            .meta({
              description:
                "Absolute epoch-ms deadline for typecheck, start, and execution; past it the " +
                "obligation settles expired/deadline instead of running or staying open.",
            }),
        }),
      )
      .default({})
      .meta({
        description:
          "The host's open script OBLIGATIONS, keyed by executionId — what SHOULD be running, " +
          "compared at head against this incarnation's live executions. Terminal settlements " +
          "delete their entry.",
      }),
    preamble: z
      .array(
        z.strictObject({
          key: z.string().meta({ description: "The entry's identity — a re-set replaces it." }),
          code: z.string().meta({
            description:
              "TypeScript statements injected above every script in this scope, at typecheck " +
              "and at execution.",
          }),
          setAtOffset: z
            .number()
            .int()
            .nonnegative()
            .meta({
              description:
                "The offset of the FIRST preamble-set for this key: entries concatenate in " +
                "this order, and a later re-set updates code without moving the entry.",
            }),
        }) satisfies z.ZodType<PreambleEntry, unknown>,
      )
      .default([])
      .meta({
        description:
          "User/agent-authored preamble entries, in injection order. The `results` array is " +
          "NOT here — it is derived from settledScriptResults at assembly time.",
      }),
    settledScriptResults: z
      .array(
        z
          .discriminatedUnion("kind", [
            z.strictObject({
              kind: z.literal("data").meta({
                description: "A small result, retained verbatim for inline embedding.",
              }),
              executionId: z.string(),
              scriptOffset: z
                .number()
                .int()
                .nonnegative()
                .optional()
                .meta({
                  description:
                    "The run's script-run-requested event offset — the reuse handle " +
                    "previousScriptHelper demands. Absent when no request was reduced.",
                }),
              settledAtOffset: z.number().int().nonnegative(),
              resultJson: z.string().meta({
                description:
                  "JSON.stringify of the settlement's result — embedded as a literal in the " +
                  "assembled `results` array so scripts read `.data` with its literal type.",
              }),
            }),
            z.strictObject({
              kind: z.literal("large").meta({
                description:
                  "An oversized result: only its inferred type is retained; scripts load the " +
                  "payload back with the entry's async `load(itx)` helper, which re-reads the " +
                  "settlement event.",
              }),
              executionId: z.string(),
              scriptOffset: z
                .number()
                .int()
                .nonnegative()
                .optional()
                .meta({
                  description:
                    "The run's script-run-requested event offset — the reuse handle " +
                    "previousScriptHelper demands. Absent when no request was reduced.",
                }),
              settledAtOffset: z.number().int().nonnegative(),
              typeText: z.string().meta({
                description: "The inferred TypeScript type of the result (inferJsonType).",
              }),
            }),
            z.strictObject({
              kind: z.literal("omitted").meta({
                description:
                  "A successful script whose return value was dropped at the settlement " +
                  "boundary for being oversized (boundScriptSettlement). Only its inferred " +
                  "type and size survive; there is no payload to embed or load.",
              }),
              executionId: z.string(),
              scriptOffset: z
                .number()
                .int()
                .nonnegative()
                .optional()
                .meta({
                  description:
                    "The run's script-run-requested event offset — the reuse handle " +
                    "previousScriptHelper demands. Absent when no request was reduced.",
                }),
              settledAtOffset: z.number().int().nonnegative(),
              typeText: z.string().meta({
                description: "The inferred TypeScript type of the dropped result (inferJsonType).",
              }),
              serializedChars: z.number().int().nonnegative().meta({
                description: "How large the dropped result's compact JSON was.",
              }),
            }),
            z.strictObject({
              kind: z.literal("error").meta({ description: "A failed script." }),
              executionId: z.string(),
              scriptOffset: z
                .number()
                .int()
                .nonnegative()
                .optional()
                .meta({
                  description:
                    "The run's script-run-requested event offset — the reuse handle " +
                    "previousScriptHelper demands. Absent when no request was reduced.",
                }),
              settledAtOffset: z.number().int().nonnegative(),
              error: z.string().meta({ description: "The settlement error, truncated." }),
            }),
            z.strictObject({
              kind: z.literal("done").meta({
                description:
                  "A successful script that returned no (JSON-serializable) value. No payload " +
                  "to reference, but the offset stays addressable — the reuse handle for " +
                  "previousScriptAsHelperFunction.",
              }),
              executionId: z.string(),
              scriptOffset: z
                .number()
                .int()
                .nonnegative()
                .optional()
                .meta({
                  description:
                    "The run's script-run-requested event offset — the reuse handle " +
                    "previousScriptHelper demands. Absent when no request was reduced.",
                }),
              settledAtOffset: z.number().int().nonnegative(),
            }),
          ])
          .meta({
            description: "One retained script outcome — a row of the derived `results` array.",
          }) satisfies z.ZodType<RetainedScriptResult, unknown>,
      )
      .default([])
      .meta({
        description:
          "The most recent script outcomes in this scope, oldest first, capped at " +
          "RETAINED_SCRIPT_RESULTS_LIMIT. The preamble assembler renders these (newest first) " +
          "into the `results` array every script sees; the settlement event remains the only " +
          "durable storage for full payloads.",
      }),
  }),
  events: {
    "events.iterate.com/capability-host/created": {
      description:
        "Creates a capability-host processor on this stream. The birth certificate records the scope's `fallback`: the itx expression a capability miss follows (usually straight to the project root host), or null at the root.",
      payloadSchema: capabilityHostBirthCertificateSchema(),
    },
    "events.iterate.com/capability-host/capability-provider-pager-connected": {
      description:
        "A provider client gave this Durable Object a hibernatable Pager: a return channel the host can Page after releasing ordinary RPC references. The event's offset is the Pager's durable identity.",
      payloadSchema: z.strictObject({}),
    },
    "events.iterate.com/capability-host/capability-provider-pager-disconnected": {
      description:
        "One exact Capability Provider Pager disappeared. Every live mount referencing its connected event retires atomically; replacement Pagers and their mounts are unaffected.",
      payloadSchema: z.strictObject({
        connectedAtOffset: z.number().int().nonnegative(),
      }),
    },
    "events.iterate.com/capability-host/capability-provided": {
      description: "A capability was mounted at a path.",
      payloadSchema: z
        .discriminatedUnion("type", [
          z.strictObject({
            type: z.literal("live").meta({
              description:
                "A Pager-backed live mount: the client gives the host a hibernatable return " +
                "channel so it can Page the provider relay after releasing ordinary RPC references; " +
                "only this record is durable.",
            }),
            path: z
              .array(z.string())
              .meta({ description: 'Mount point as path segments, e.g. ["tools", "weather"].' }),
            providerPager: z
              .strictObject({
                connectedAtOffset: z.number().int().nonnegative(),
              })
              .meta({
                description:
                  "The capability-provider-pager-connected event for the client-given Pager " +
                  "that can return this mount's provider. It contains no socket id or RPC stub.",
              }),
            instructions: z
              .string()
              .optional()
              .meta({
                description:
                  "Prose for the model: what the capability does and how to call it " +
                  "(surfaced by __describe and itx.docs).",
              }),
            types: z
              .string()
              .optional()
              .meta({
                description:
                  "The mount's Capability Type Declaration — TypeScript declaration text " +
                  "describing the mounted value; read by itx.docs and the script typecheck gate.",
              }),
            flattenNestedPaths: z
              .boolean()
              .optional()
              .meta({
                description:
                  "True when the provider is a dispatcher: any dotted call under the mount " +
                  "arrives as ONE invokeCapability({ path, args }) instead of property traversal.",
              }),
          }),
          z.strictObject({
            type: z.literal("itx-call").meta({
              description:
                "A durable mount: the recorded expression is re-evaluated against this " +
                "scope's own itx on every call.",
            }),
            path: z
              .array(z.string())
              .meta({ description: 'Mount point as path segments, e.g. ["pets"].' }),
            expression: z.array(ItxExpressionStep).meta({
              description:
                "The recipe: property names and [method, ...args] steps walked over this " +
                "scope's itx on every use.",
            }),
            instructions: z
              .string()
              .optional()
              .meta({
                description:
                  "Prose for the model: what the capability does and how to call it " +
                  "(surfaced by __describe and itx.docs).",
              }),
            types: z
              .string()
              .optional()
              .meta({
                description:
                  "The mount's Capability Type Declaration — TypeScript declaration text " +
                  "describing the mounted value; read by itx.docs and the script typecheck gate.",
              }),
            flattenNestedPaths: z
              .boolean()
              .optional()
              .meta({
                description:
                  "True when the evaluated provider is a dispatcher: any dotted call under the " +
                  "mount arrives as ONE invokeCapability({ path, args }) instead of property " +
                  "traversal.",
              }),
          }),
        ])
        .meta({
          description: "The mount record — everything durable about the capability.",
        }) satisfies z.ZodType<CapabilityProvidedPayload, unknown>,
    },
    "events.iterate.com/capability-host/capability-revoked": {
      description: "A dynamic capability was removed.",
      payloadSchema: z.strictObject({
        path: z
          .array(z.string())
          .meta({ description: "The mount point to revoke, as path segments." }),
        providedAtOffset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .meta({
            description:
              "Revoke only the exact mount created at this offset; if the path has been " +
              "re-mounted since, the revoke reduces to a no-op instead of tearing down the " +
              "newer mount.",
          }),
      }) satisfies z.ZodType<RevokeCapabilityInput, unknown>,
    },
    "events.iterate.com/capability-host/script-run-requested": {
      description:
        "A script should run in this capability scope. Before any attempt starts, the code is typechecked against the scope's capability types: a script with a PROVABLE error — a syntax error, or a near-miss typo where the compiler names the fix (\"Did you mean 'get'?\") — settles straight to an error completion carrying the compiler errors, without ever running (no started event). Everything less certain runs: capabilities are provided dynamically and declared types can lag the runtime, so bare property/argument mismatches, unknown/untyped capabilities, non-async block shapes, and checker failures all let the script run unchecked.",
      payloadSchema: z.strictObject({
        code: z.string().meta({ description: "The TypeScript script source to run." }),
        executionId: z.string().meta({
          description:
            "Caller-supplied obligation identity — the cross-stream correlation key the " +
            "settlement points back at, and what every settle idempotency key derives from.",
        }),
        expiresAt: z
          .number()
          .int()
          .positive()
          .meta({
            description:
              "Absolute epoch-ms deadline for typecheck, start, and execution. Recovery can " +
              "deliver this request arbitrarily late; past the deadline it settles expired " +
              "instead of running.",
          }),
      }),
    },
    "events.iterate.com/capability-host/script-run-started": {
      description:
        "An attempt to run the script began. Appended BEFORE the script body executes, so requested-without-started provably never ran (safe to start late) while started-without-settled died mid-run (settled as failure, never re-run).",
      payloadSchema: z.looseObject({
        executionId: z.string().meta({ description: "The obligation this attempt belongs to." }),
      }),
    },
    "events.iterate.com/capability-host/script-run-settled": {
      description:
        "The one durable settlement for a script obligation. Failures classify where execution stopped, whether script code may have run, and whether cancellation can prove external work ended.",
      payloadSchema: z.strictObject({
        executionId: z.string().meta({ description: "The obligation this settlement closes." }),
        settlement: ScriptExecutionSettlement,
      }),
    },
    "events.iterate.com/capability-host/preamble-set": {
      description:
        "Upserts one preamble entry: TypeScript injected above every later script in this scope, at typecheck and at execution. Keyed — a re-set at the same key replaces the code but keeps the entry's injection position (first-set offset). Entries recorded through setPreamble were compiled against the scope's assembled preamble at set time; a stale entry that stops compiling later never blocks a script (the run gate downgrades preamble-line errors to unchecked).",
      payloadSchema: z.strictObject({
        key: z.string().min(1).meta({ description: "The entry's identity." }),
        code: z.string().meta({ description: "TypeScript statements to inject." }),
      }),
    },
    "events.iterate.com/capability-host/preamble-removed": {
      description: "Removes one preamble entry by key; unknown keys reduce to a no-op.",
      payloadSchema: z.strictObject({
        key: z.string().meta({ description: "The entry to remove." }),
      }),
    },
  },
  consumes: [
    "events.iterate.com/capability-host/created",
    "events.iterate.com/capability-host/capability-provider-pager-connected",
    "events.iterate.com/capability-host/capability-provider-pager-disconnected",
    "events.iterate.com/capability-host/capability-provided",
    "events.iterate.com/capability-host/capability-revoked",
    "events.iterate.com/capability-host/script-run-requested",
    "events.iterate.com/capability-host/script-run-started",
    "events.iterate.com/capability-host/script-run-settled",
    "events.iterate.com/capability-host/preamble-set",
    "events.iterate.com/capability-host/preamble-removed",
    // Deliberately NOT consumed: `stream/woken` and the
    // `stream/connection-opened` / `stream/connection-closed` presence facts.
    // Old versions consumed platform lifecycle events as extra
    // "re-check at head" turns for the script-obligation pass, but the runner
    // now guarantees an at-head `processEvent` pass (event: null) whenever a
    // delivery reaches head without a consumed event carrying it — so any
    // append that wakes the stream, those lifecycle events included, already produces the
    // turn that retries a transiently failed settlement.
    // Recovery relies on the eventless at-head pass, not consumption of the
    // platform revival fact, to re-drive open script obligations.
  ],
  emits: [
    "events.iterate.com/capability-host/created",
    "events.iterate.com/capability-host/capability-provider-pager-connected",
    "events.iterate.com/capability-host/capability-provider-pager-disconnected",
    "events.iterate.com/capability-host/capability-provided",
    "events.iterate.com/capability-host/capability-revoked",
    "events.iterate.com/capability-host/script-run-requested",
    "events.iterate.com/capability-host/script-run-started",
    "events.iterate.com/capability-host/script-run-settled",
    "events.iterate.com/capability-host/preamble-set",
    "events.iterate.com/capability-host/preamble-removed",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<CapabilityHostProcessorContract>`,
 * `ConsumedEvent<CapabilityHostProcessorContract>`.
 */
export type CapabilityHostProcessorContract = typeof CapabilityHostProcessorContract;

/**
 * The birth certificate — the ONE schema the contract uses twice (the state's
 * `birthCertificate` slot and the `capability-host/created` payload), so it
 * lives in this hoisted function instead of inline.
 */
function capabilityHostBirthCertificateSchema() {
  return z.strictObject({
    config: z.strictObject({}).meta({ description: "Reserved. Every host is born with {} today." }),
    fallback: ItxExpression.nullish().meta({
      description:
        "Where capability reads go on a local miss: an itx expression naming ONE other host " +
        '— usually ["capabilityHosts", ["get", "/"]], the project root — or null, which ends ' +
        "resolution here. Recorded at birth and re-evaluated against this scope's own itx " +
        "on every fallback read, so the expression is a durable name, never captured " +
        "authority. Nullish only so pre-fallback birth certificates still parse; absent " +
        "means null.",
    }),
  });
}

/**
 * The one platform rule for what a new host at `path` records as its
 * fallback: the project root ends resolution; every other scope falls back
 * directly to the project root host, in one hop. There is deliberately no
 * multi-level scope walking — a scope that wants different inheritance
 * records a different expression at birth.
 */
export function capabilityFallbackForScope(path: string): ItxExpression | null {
  return path === "/" ? null : ["capabilityHosts", ["get", "/"]];
}

/**
 * Absolute lifetime of a script-run-requested obligation, used by requesters
 * (agent processors, the public runScript door) to stamp `expiresAt`.
 * Recovery can deliver the request arbitrarily late, and an already-started
 * worker RPC can hang indefinitely; both are settled at this deadline rather
 * than running or remaining busy without bound.
 */
export const DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS = 15 * 60_000;

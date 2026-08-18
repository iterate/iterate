// core/config.ts — the typed APP_CONFIG. Its heart is `seeds`: mount rows (pattern ⇒ target) in
// the SAME expression grammar userspace `provideCapability` uses, written in either half of the
// codec ("most people would prefer the string"). Seeds sit at the BOTTOM of every shadow stack,
// with provenance `config` — the ONLY provenance whose targets see the host-scope roots (kv,
// stream, contexts, bindings, … — roots-builder.ts). Topology lives here as data:
//
//   iterate-hosted   { "pattern": "itx.os", "target": "bindings.get('FALLBACK')" }
//   BYO-cloud        { "pattern": "itx.os", "target": "dial('https://os.iterate.com/api')" }
//   solo/dev         (omit APP_CONFIG entirely — the defaults below apply)
//
// Secrets NEVER appear here: a dial's auth rides `{{secret:NAME}}` placeholders inside ordinary
// request headers, substituted at the egress terminal from the per-project store.

import { z } from "zod";
import { ExpressionSchema, parse, type Expression } from "./expression.ts";

const ExpressionInput = z.union([z.string().transform((s) => parse(s)), ExpressionSchema]);

const SeedRow = z.object({
  pattern: ExpressionInput,
  target: ExpressionInput,
});

export const AppConfig = z.object({
  seeds: z.array(SeedRow).default([]),
});
export type AppConfig = z.infer<typeof AppConfig>;

/** The solo/dev seed set: every platform built-in, no default route (misses are errors). */
export const DEFAULT_SEEDS: { pattern: string; target: string }[] = [
  { pattern: "itx.whoami", target: "whoami" },
  { pattern: "itx.kv", target: "kv" },
  { pattern: "itx.secrets", target: "secrets" },
  /** MY stream (append/read — the commonest write is now dotted-door spellable). */
  { pattern: "itx.stream", target: "stream" },
  /** Sibling contexts, ROUTED — each is a whole context, not just a log. */
  { pattern: "itx.contexts", target: "contexts" },
  { pattern: "itx.clients", target: "clients" },
  { pattern: "itx.facets", target: "facets" },
  { pattern: "itx.workers", target: "workers" },
  { pattern: "itx.files", target: "files" },
  { pattern: "itx.repo", target: "repo" },
  { pattern: "itx.os", target: "bindings.get('FALLBACK')" },
];

/** Parse env.APP_CONFIG (fail-loud on malformed config — a typo must not boot a mis-wired
 *  project) and return the seed mounts. DEFAULT_SEEDS apply ONLY when APP_CONFIG is entirely
 *  absent (the solo default); a present config's seeds are taken verbatim — an explicit
 *  `{"seeds": []}` means DENY-ALL, not "give me the defaults". */
export function parseAppConfig(raw: string | undefined): {
  seeds: { pattern: Expression; target: Expression }[];
} {
  if (!raw)
    return {
      seeds: DEFAULT_SEEDS.map((s) => ({ pattern: parse(s.pattern), target: parse(s.target) })),
    };
  return { seeds: AppConfig.parse(JSON.parse(raw)).seeds };
}

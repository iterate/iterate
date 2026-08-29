// core/config.ts — the typed APP_CONFIG. Its heart is `configMounts`: mount rows
// (capability path ⇒ target expression), written string-first ("most people would prefer the
// string"). Config mounts sit at the BOTTOM of every shadow stack, with provenance `config` —
// the ONLY provenance whose targets see the built-ins (kv, stream, cd, connections, … —
// built-ins.ts). Topology lives here as data:
//
//   iterate-hosted   { "pattern": "itx.os", "target": "bindings.get('FALLBACK')" }
//   BYO-cloud        { "pattern": "itx.os", "target": "dial('https://os.iterate.com/api')" }
//   solo/dev         (omit APP_CONFIG entirely — the defaults below apply)
//
// Secrets NEVER appear here: a dial's auth rides `{{secret:NAME}}` placeholders inside ordinary
// request headers, substituted at the egress terminal from the per-project store.

import { z } from "zod";
import { parse, parseCapabilityPath, type CapabilityPath, type Expression } from "./expression.ts";

/** The structured half of an expression as a wire schema — reduced-state checkpoints validate a
 *  target against this one spelling (events store the STRING half). */
const ExpressionSchema = z.array(
  z.union([z.string(), z.tuple([z.string()]).rest(z.unknown())]),
) as z.ZodType<Expression>;

// A path is dotted-string OR pre-split segments; EITHER way each segment must be a real
// identifier (an array like ["itx.kv"] or [] would otherwise boot a dead or rank-0 default
// mount that z.custom(() => true) waved through). Round-trip both forms through the grammar.
const CapabilityPathInput = z.union([z.string(), z.array(z.string())]).transform((p, ctx) => {
  try {
    const segs = parseCapabilityPath(Array.isArray(p) ? p.join(".") : p);
    // An array is PRE-SPLIT segments: it must round-trip 1:1. ["itx.kv"] re-splits to two — reject
    // the mis-segmentation loudly rather than silently reshaping it into a different mount.
    if (Array.isArray(p) && (segs.length !== p.length || segs.some((s, i) => s !== p[i])))
      throw new Error(
        `capability path array must be one identifier per segment: ${JSON.stringify(p)}`,
      );
    return segs;
  } catch (e) {
    ctx.addIssue({ code: "custom", message: e instanceof Error ? e.message : String(e) });
    return z.NEVER;
  }
});
const ExpressionInput = z.union([z.string().transform((s) => parse(s)), ExpressionSchema]);

const ConfigMountRow = z.object({
  path: CapabilityPathInput,
  target: ExpressionInput,
});

const AppConfig = z.object({
  configMounts: z.array(ConfigMountRow).default([]),
});
type AppConfig = z.infer<typeof AppConfig>;

/** The solo/dev config-mount set: every platform built-in, no default route (misses are
 *  errors). */
export const DEFAULT_CONFIG_MOUNTS: { path: string; target: string }[] = [
  { path: "itx.whoami", target: "whoami" },
  { path: "itx.kv", target: "kv" },
  { path: "itx.secrets", target: "secrets" },
  /** MY stream (append/read — the commonest write is dotted-door spellable). */
  { path: "itx.stream", target: "stream" },
  /** Navigate to a sibling context, ROUTED — each is a whole context, not just a log. */
  { path: "itx.cd", target: "cd" },
  { path: "itx.rpcStubs", target: "rpcStubs" },
  { path: "itx.facets", target: "facets" },
  { path: "itx.workers", target: "workers" },
  /** Run stateless code — sugar over `workers.get({type:'stateless',source}).run(…)`. */
  { path: "itx.runScript", target: "runScript" },
  { path: "itx.os", target: "bindings.get('FALLBACK')" },
];

/** Parse env.APP_CONFIG (fail-loud on malformed config — a typo must not boot a mis-wired
 *  project) and return the config mounts. DEFAULT_CONFIG_MOUNTS apply ONLY when APP_CONFIG is
 *  entirely absent (the solo default); a present config's mounts are taken verbatim — an
 *  explicit `{"configMounts": []}` means DENY-ALL, not "give me the defaults". */
export function parseAppConfig(raw: string | undefined): {
  configMounts: { path: CapabilityPath; target: Expression }[];
} {
  if (!raw)
    return {
      configMounts: DEFAULT_CONFIG_MOUNTS.map((s) => ({
        path: parseCapabilityPath(s.path),
        target: parse(s.target),
      })),
    };
  return { configMounts: AppConfig.parse(JSON.parse(raw)).configMounts };
}

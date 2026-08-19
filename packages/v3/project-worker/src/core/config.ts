// core/config.ts — the typed APP_CONFIG. Its heart is `configMounts`: mount rows
// (capability path ⇒ target expression), written string-first ("most people would prefer the
// string"). Config mounts sit at the BOTTOM of every shadow stack, with provenance `config` —
// the ONLY provenance whose targets see the built-ins (kv, stream, contexts, connections, … —
// built-ins.ts). Topology lives here as data:
//
//   iterate-hosted   { "pattern": "itx.os", "target": "bindings.get('FALLBACK')" }
//   BYO-cloud        { "pattern": "itx.os", "target": "dial('https://os.iterate.com/api')" }
//   solo/dev         (omit APP_CONFIG entirely — the defaults below apply)
//
// Secrets NEVER appear here: a dial's auth rides `{{secret:NAME}}` placeholders inside ordinary
// request headers, substituted at the egress terminal from the per-project store.

import { z } from "zod";
import {
  ExpressionSchema,
  parse,
  parseCapabilityPath,
  type CapabilityPath,
  type Expression,
} from "./expression.ts";

const CapabilityPathInput = z
  .union([z.string().transform((s) => parseCapabilityPath(s)), z.array(z.string())])
  .pipe(z.custom<CapabilityPath>(() => true));
const ExpressionInput = z.union([z.string().transform((s) => parse(s)), ExpressionSchema]);

const ConfigMountRow = z.object({
  path: CapabilityPathInput,
  target: ExpressionInput,
});

export const AppConfig = z.object({
  configMounts: z.array(ConfigMountRow).default([]),
});
export type AppConfig = z.infer<typeof AppConfig>;

/** The solo/dev config-mount set: every platform built-in, no default route (misses are
 *  errors). */
export const DEFAULT_CONFIG_MOUNTS: { path: string; target: string }[] = [
  { path: "itx.whoami", target: "whoami" },
  { path: "itx.kv", target: "kv" },
  { path: "itx.secrets", target: "secrets" },
  /** MY stream (append/read — the commonest write is dotted-door spellable). */
  { path: "itx.stream", target: "stream" },
  /** Sibling contexts, ROUTED — each is a whole context, not just a log. */
  { path: "itx.contexts", target: "contexts" },
  { path: "itx.clients", target: "clients" },
  { path: "itx.facets", target: "facets" },
  { path: "itx.workers", target: "workers" },
  { path: "itx.files", target: "files" },
  { path: "itx.repo", target: "repo" },
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

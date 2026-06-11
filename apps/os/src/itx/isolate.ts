// ONE place wires the environment of every isolate the platform loads —
// source caps (dial.ts, including the project's own worker) and the
// /api/itx/run script harness all describe the same trust posture:
//
//   env.ITERATE    — an itx scoped to the isolate's HOME context (Law 4: a
//                    cap can never reach wider than where it is provided);
//                    `capabilityPath` is attribution.
//   env.STREAMS    — the project's streams capability.
//   globalOutbound — PROJECT EGRESS (Law 5): bare fetch() inside the isolate,
//                    including fetches made by bundled npm dependencies, rides
//                    the egress pipe — secret placeholders are substituted
//                    outside the isolate, which never sees material.
//
// Loaders differ only in their loopback accessor (a DO's ctx.exports vs the
// dial's host.loopback).

import type { CapabilityAddress } from "./itx.ts";

export const ISOLATE_COMPATIBILITY_DATE = "2026-04-27";
export const ISOLATE_COMPATIBILITY_FLAGS = ["nodejs_compat"];

export type IsolateLoopback = (
  exportName: string,
  options: { props: Record<string, unknown> },
) => unknown;

export type IsolateCode = {
  mainModule: string;
  modules: Record<string, unknown>;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
};

export function wireIsolateEnv(input: {
  loopback: IsolateLoopback;
  /** Attribution: which capability's isolate this is. */
  capabilityPath: string;
  /** The isolate's home context — its ITERATE can never reach wider. */
  contextId: string;
  /** The home context's ADDRESS: how the egress dispatcher and the restorer
   * dial the context node without a directory lookup on the hot path.
   * null falls back to the project context. */
  contextAddress?: CapabilityAddress | null;
  /** The owning project — egress (and its secrets) are scoped to it. */
  projectId: string;
  code: IsolateCode;
  /** Extra named bindings (e.g. the project worker's STREAMS). */
  extraEnv?: Record<string, unknown>;
}) {
  return {
    compatibilityDate: input.code.compatibilityDate ?? ISOLATE_COMPATIBILITY_DATE,
    compatibilityFlags: input.code.compatibilityFlags ?? ISOLATE_COMPATIBILITY_FLAGS,
    env: {
      ITERATE: input.loopback("ItxEntrypoint", {
        props: {
          capabilityPath: input.capabilityPath,
          context: input.contextId,
          contextAddress: input.contextAddress ?? null,
          projectId: input.projectId,
        },
      }),
      // The project's streams, same posture in EVERY isolate (the project
      // worker, source caps, scripts): identical env means identical
      // loader-cache entries, so all load sites share warm isolates.
      STREAMS: input.loopback("StreamsBackend", {
        props: { projectId: input.projectId },
      }),
      ...input.extraEnv,
    },
    globalOutbound: input.loopback("ProjectEgress", {
      props: {
        capabilityPath: input.capabilityPath,
        context: input.contextId,
        contextAddress: input.contextAddress ?? null,
        projectId: input.projectId,
      },
    }),
    mainModule: input.code.mainModule,
    modules: input.code.modules,
  };
}

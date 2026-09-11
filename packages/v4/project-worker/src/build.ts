// build.ts — public, inert build values. Building does not load code: only workers.load() adds
// the contextual ITX capability and outbound-fetch policy.

import { z } from "zod";
import type { NativeWorkerCode } from "./context/worker-loader.ts";

const FileMap = z
  .record(z.string().min(1).max(240), z.string().max(1_048_576))
  .superRefine((files, context) => {
    const entries = Object.entries(files);
    if (entries.length < 1 || entries.length > 1_024)
      context.addIssue({ code: "custom", message: "A build needs 1 to 1024 source files" });
    if (entries.some(([path]) => path.startsWith("/") || path.includes("..")))
      context.addIssue({ code: "custom", message: "Build file paths must be relative" });
  });

/** The deliberately small, serializable subset of worker-bundler options. */
export const BuildOptions = z.strictObject({
  entryPoint: z.string().min(1).max(240),
  target: z.string().min(1).max(80).optional(),
  minify: z.boolean().optional(),
  sourcemap: z.boolean().optional(),
});

/** Direct immutable source bytes. This is what the stateless bundler consumes. */
export const BundleInput = z.strictObject({
  files: FileMap,
  options: BuildOptions,
});
export type BundleInput = z.infer<typeof BundleInput>;

/** A repo reference is resolved by the context before it is sent to the stateless bundler. */
export const RepositoryBuildInput = z.strictObject({
  source: z.strictObject({
    repo: z.string().min(1).max(240),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  options: BuildOptions,
});
export type RepositoryBuildInput = z.infer<typeof RepositoryBuildInput>;

/** The public build verb accepts source bytes or a pinned repository revision. */
export const BuildInput = z.union([BundleInput, RepositoryBuildInput]);
export type BuildInput = z.infer<typeof BuildInput>;

/** A bundle is loader-ready but inert: it contains no context bindings or capability. */
export type BuildResult =
  | { status: "rejected"; diagnostics: string[] }
  | {
      status: "built";
      code: NativeWorkerCode;
      diagnostics: string[];
      key: string;
      cache: "hit" | "miss";
    };

/** One compiler diagnostic, deliberately plain data rather than a TypeScript compiler object. */
export type CheckDiagnostic = {
  file?: string;
  line?: number;
  column?: number;
  code: number;
  message: string;
};

/** Checking has no authority and produces no executable code. */
export type CheckResult =
  | { status: "checked"; diagnostics: CheckDiagnostic[] }
  | { status: "rejected"; diagnostics: CheckDiagnostic[] };

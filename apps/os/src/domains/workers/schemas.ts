import { z } from "zod";
import type { CreateWorkerOptions } from "@cloudflare/worker-bundler";
import { normalizePath } from "../durable-object-names.ts";
import type {
  StatefulDynamicWorkerRef as StatefulWorkerRefType,
  StatelessDynamicWorkerRef as StatelessWorkerRefType,
  DynamicWorkerRef as WorkerRefType,
  DynamicWorkerSource as WorkerSourceType,
  WorkerBuildOptions as WorkerBuildOptionsType,
  WorkerFileSource as WorkerFileSourceType,
} from "../../types.ts";

const DURABLE_WORKER_KEY = /^[a-z][a-z0-9-]{0,62}$/;

const WorkerFileSource = z.discriminatedUnion("type", [
  z.strictObject({
    files: z.record(z.string(), z.string()),
    type: z.literal("inline"),
  }),
  z.strictObject({
    exclude: z.array(z.string()).optional(),
    include: z.array(z.string()).optional(),
    ref: z
      .union([
        z.strictObject({ branch: z.string().min(1) }),
        z.strictObject({
          branch: z.string().min(1).optional(),
          commitOid: z.string().regex(/^[0-9a-f]{40}$/),
        }),
      ])
      .optional(),
    repoPath: z.string(),
    type: z.literal("repo"),
  }),
]) satisfies z.ZodType<WorkerFileSourceType, unknown>;

const WorkerBundlerLoader = z.enum([
  "js",
  "jsx",
  "ts",
  "tsx",
  "json",
  "css",
  "text",
  "binary",
  "base64",
  "dataurl",
]);

export const WorkerBuildOptions = z.strictObject({
  bundle: z.boolean().optional(),
  conditions: z.array(z.string()).optional(),
  define: z.record(z.string(), z.string()).optional(),
  entryPoint: z.string().optional(),
  externals: z.array(z.string()).optional(),
  jsx: z.enum(["transform", "preserve", "automatic"]).optional(),
  jsxImportSource: z.string().optional(),
  loader: z.record(z.string(), WorkerBundlerLoader).optional(),
  minify: z.boolean().optional(),
  registry: z.string().optional(),
  sourcemap: z.boolean().optional(),
  target: z.string().optional(),
  virtualModules: z.record(z.string(), z.string()).optional(),
}) satisfies z.ZodType<WorkerBuildOptionsType, unknown>;

// The public build options are Cloudflare's `CreateWorkerOptions` minus
// `files` (OS supplies files from the selected file source) and minus the
// explicitly-not-semver esbuild-plugin escape hatch (not serializable into a
// durable worker recipe). This assignability pin means a bundler option
// reshape fails typecheck here instead of silently forking the two shapes.
type CloudflareWorkerBuildOptions = Omit<
  CreateWorkerOptions,
  "files" | "__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired"
>;
export const workerBuildOptionsMatchCloudflare = (
  options: WorkerBuildOptionsType,
): CloudflareWorkerBuildOptions => options;

export const DynamicWorkerSource = z.strictObject({
  files: WorkerFileSource,
  options: WorkerBuildOptions.optional(),
}) satisfies z.ZodType<WorkerSourceType, unknown>;

const WorkerRefBase = {
  path: z.string().transform(normalizePath),
  source: DynamicWorkerSource,
};

const StatelessDynamicWorkerRef = z.strictObject({
  ...WorkerRefBase,
  entrypoint: z.string().optional(),
  props: z.record(z.string(), z.json()).optional(),
  type: z.literal("stateless"),
}) satisfies z.ZodType<StatelessWorkerRefType, unknown>;

const StatefulDynamicWorkerRef = z.strictObject({
  ...WorkerRefBase,
  className: z.string(),
  durableWorkerKey: z.string().regex(DURABLE_WORKER_KEY),
  type: z.literal("stateful"),
}) satisfies z.ZodType<StatefulWorkerRefType, unknown>;

export const DynamicWorkerRef = z.discriminatedUnion("type", [
  StatelessDynamicWorkerRef,
  StatefulDynamicWorkerRef,
]) satisfies z.ZodType<WorkerRefType, unknown>;

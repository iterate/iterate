import { z } from "zod/v4";

const d1BindingSchema = z.custom<D1Database>(
  (value) => typeof value === "object" && value !== null && "prepare" in value,
  { message: "DB binding is required" },
);

const typeIdPrefixSchema = z
  .string()
  .trim()
  .default("ipr")
  .transform((value) => value.replace(/_+$/g, ""))
  .refine((value) => /^[a-z]+$/.test(value), {
    message: "TYPEID_PREFIX must contain lowercase letters only",
  });

export const workerEnvSchema = z.object({
  DB: d1BindingSchema,
  INGRESS_PROXY_API_TOKEN: z.string().trim().min(1, "INGRESS_PROXY_API_TOKEN is required"),
  TYPEID_PREFIX: typeIdPrefixSchema,
});

export type RawProxyWorkerEnv = z.input<typeof workerEnvSchema>;
export type ProxyWorkerEnv = z.output<typeof workerEnvSchema>;

export function parseWorkerEnv(env: RawProxyWorkerEnv): ProxyWorkerEnv {
  return workerEnvSchema.parse(env);
}

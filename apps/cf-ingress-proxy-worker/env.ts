import { z } from "zod/v4";

export const WorkerEnv = z.object({
  DB: z.custom<D1Database>(
    (value) => typeof value === "object" && value !== null && "prepare" in value,
    { message: "DB binding is required" },
  ),
  INGRESS_PROXY_API_TOKEN: z.string().trim().min(1, "INGRESS_PROXY_API_TOKEN is required"),
  TYPEID_PREFIX: z
    .string()
    .trim()
    .default("ipr")
    .transform((value) => value.replace(/_+$/g, ""))
    .refine((value) => /^[a-z]+$/.test(value), {
      message: "TYPEID_PREFIX must contain lowercase letters only",
    }),
});

export type RawProxyWorkerEnv = z.input<typeof WorkerEnv>;
export type ProxyWorkerEnv = z.output<typeof WorkerEnv>;

export function parseWorkerEnv(env: RawProxyWorkerEnv): ProxyWorkerEnv {
  return WorkerEnv.parse(env);
}

import { z } from "zod/v4";

export const ingressProxyWorkerEnvSchema = z.object({
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

export type RawIngressProxyWorkerEnv = Partial<z.infer<typeof ingressProxyWorkerEnvSchema>>;
export type IngressProxyWorkerEnv = z.infer<typeof ingressProxyWorkerEnvSchema>;

const parsedEnvCache = new WeakMap<object, IngressProxyWorkerEnv>();

export function parseWorkerEnv(env: RawIngressProxyWorkerEnv): IngressProxyWorkerEnv {
  const key = env as object;
  const cached = parsedEnvCache.get(key);
  if (cached) return cached;

  const parsed = ingressProxyWorkerEnvSchema.parse(env);
  parsedEnvCache.set(key, parsed);
  return parsed;
}

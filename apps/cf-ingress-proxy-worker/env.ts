import { z } from "zod/v4";
import { TypeIdPrefixSchema } from "./typeid-prefix.ts";

export const WorkerEnv = z.object({
  DB: z.custom<D1Database>(
    (value) => typeof value === "object" && value !== null && "prepare" in value,
    { message: "DB binding is required" },
  ),
  INGRESS_PROXY_API_TOKEN: z.string().trim().min(1, "INGRESS_PROXY_API_TOKEN is required"),
  TYPEID_PREFIX: TypeIdPrefixSchema,
});

export type RawProxyWorkerEnv = z.input<typeof WorkerEnv>;
export type ProxyWorkerEnv = z.output<typeof WorkerEnv>;

export function parseWorkerEnv(env: RawProxyWorkerEnv): ProxyWorkerEnv {
  return WorkerEnv.parse(env);
}

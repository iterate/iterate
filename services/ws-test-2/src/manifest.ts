import { z } from "zod";

export const wsTest2ServiceEnvSchema = z.object({
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  VITE_BACKEND_PORT: z.coerce.number().int().positive().optional(),
});

export const wsTest2ServiceManifest = {
  packageName: "@iterate-com/ws-test-2",
  serviceName: "ws-test",
  displayName: "ws-test",
  frontendTitle: "ws-test",
  apiBasePath: "/api",
  rpcPath: "/api/rpc",
  ptyWebSocketPath: "/api/pty/ws",
  envSchema: wsTest2ServiceEnvSchema,
} as const;

export type WsTest2ServiceEnv = z.infer<typeof wsTest2ServiceEnvSchema>;

export function getWsTest2ServiceEnv(raw: Record<string, string | undefined> = process.env) {
  return wsTest2ServiceEnvSchema.parse(raw);
}

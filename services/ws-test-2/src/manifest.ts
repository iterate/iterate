import { z } from "zod";

export const WsTest2ServiceEnv = z.object({
  HOST: z.string().trim().min(1).optional(),
  PORT: z.coerce.number().int().positive().optional(),
});

export const wsTest2ServiceManifest = {
  packageName: "@iterate-com/ws-test-2",
  serviceName: "ws-test",
  displayName: "ws-test",
  frontendTitle: "ws-test",
  apiBasePath: "/api",
  rpcPath: "/api/rpc",
  ptyWebSocketPath: "/api/pty/ws",
  envSchema: WsTest2ServiceEnv,
} as const;

export type WsTest2ServiceEnv = z.infer<typeof WsTest2ServiceEnv>;

export function getWsTest2ServiceEnv(raw: Record<string, string | undefined> = process.env) {
  return WsTest2ServiceEnv.parse(raw);
}

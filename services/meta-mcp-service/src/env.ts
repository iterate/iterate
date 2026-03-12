import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod/v4";

const ServiceEnv = z.object({
  META_MCP_SERVICE_HOST: z.string().default("0.0.0.0"),
  META_MCP_SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(19070),
  META_MCP_SERVICE_PUBLIC_URL: z.url(),
  META_MCP_SERVICE_SERVERS_PATH: z
    .string()
    .default(resolve(homedir(), ".config/meta-mcp-service/servers.json")),
  META_MCP_SERVICE_AUTH_PATH: z
    .string()
    .default(resolve(homedir(), ".config/meta-mcp-service/auth.json")),
});

export type ServiceEnv = z.infer<typeof ServiceEnv>;

const serviceEnvResult = ServiceEnv.safeParse(process.env);
if (!serviceEnvResult.success) {
  console.error("Invalid environment variables");
  console.error(z.flattenError(serviceEnvResult.error));
  process.exit(1);
}

export const serviceEnv = serviceEnvResult.data;

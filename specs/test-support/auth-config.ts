import { z } from "zod/v4";

export const OsPlaywrightAuthEnv = z.object({
  /** OS admin bearer (`secrets.adminBearer`) used to create fixture projects through /api. */
  ADMIN_API_SECRET: z.string().min(1),
  /** The sign-in page's password step (`login.password`), how fixtures sign a person in. */
  LOGIN_PASSWORD: z.string().min(1),
  /** How the deployment addresses a project: `<project>.<hostname>`, a path, or not at all. */
  PROJECT_INGRESS_ROUTING: z.string().refine((value) => {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }, "must be the deployment's ingress routing as a JSON string"),
  /** The MCP resource the OAuth specs request tokens for. */
  MCP_BASE_URL: z.url(),
});

// Suite setup supplies these values before Playwright creates its workers.
// Fixtures only read prepared configuration; they never fetch secrets.
export function readOsPlaywrightAuthConfig() {
  const env = OsPlaywrightAuthEnv.parse(process.env);
  return {
    adminApiSecret: env.ADMIN_API_SECRET,
    loginPassword: env.LOGIN_PASSWORD,
    ingressRouting: JSON.parse(env.PROJECT_INGRESS_ROUTING) as {
      type: string;
      hostname?: string;
    } | null,
    mcpBaseUrl: env.MCP_BASE_URL,
  };
}

export type OsPlaywrightAuthConfig = ReturnType<typeof readOsPlaywrightAuthConfig>;

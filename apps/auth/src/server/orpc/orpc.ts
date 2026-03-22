import { ORPCError } from "@orpc/server";
import { authContract } from "@iterate-com/auth-contract";
import { implement } from "@orpc/server";
import type { RequestHeadersPluginContext } from "@orpc/server/plugins";
import type { Variables } from "../utils/hono.ts";
import type { CloudflareEnv } from "../env.ts";

type ORPCContext = RequestHeadersPluginContext & Variables & { env: CloudflareEnv };

export const os = implement(authContract).$context<ORPCContext>();

export const superadminOnlyMiddleware = os.middleware(async ({ context, next }) => {
  const { session } = context;
  if (!session || session.user.role !== "admin")
    throw new ORPCError("UNAUTHORIZED", { message: "Not authorized" });
  return next();
});

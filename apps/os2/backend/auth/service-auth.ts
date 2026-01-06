import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/plugins";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { setSessionCookie } from "better-auth/cookies";
import { env } from "../../env.ts";
import { getDb } from "../db/client.ts";
import * as schema from "../db/schema.ts";

export const serviceAuthPlugin = () =>
  ({
    id: "service-auth",
    endpoints: {
      callback: createAuthEndpoint(
        "/service-auth/create-session",
        {
          method: "POST",
          body: z.object({
            serviceAuthToken: z.string(),
          }),
        },
        async (ctx) => {
          const { serviceAuthToken } = ctx.body;
          if (serviceAuthToken !== env.SERVICE_AUTH_TOKEN) {
            return ctx.json({ error: "Invalid service auth token" }, { status: 401 });
          }
          const db = getDb();
          const superUser = await db.query.user.findFirst({
            where: eq(schema.user.email, "admin-npc@nustom.com"),
          });

          if (!superUser) {
            return ctx.json(
              { error: "Super user not found" },
              { status: 404 },
            );
          }

          const session = await ctx.context.internalAdapter.createSession(superUser.id);
          await setSessionCookie(ctx, { session, user: superUser });
          return ctx.json({ session }, { status: 200 });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;

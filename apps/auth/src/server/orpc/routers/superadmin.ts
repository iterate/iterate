import { ORPCError } from "@orpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { os, superadminOnlyMiddleware } from "../orpc.ts";
import { schema } from "../../db/index.ts";
import { auth } from "../../auth.ts";

const superadminCreateOAuthClient = os.superadmin.oauth.createClient
  .use(superadminOnlyMiddleware)
  .handler(async ({ input }) => {
    const client = await auth.api.adminCreateOAuthClient({
      body: {
        client_name: input.clientName,
        redirect_uris: input.redirectURIs,
      },
    });
    if (!client.client_name || !client.client_secret) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "Failed to create OAuth client, got unexpected response from auth API",
        cause: { client },
      });
    }
    return {
      clientId: client.client_id,
      clientName: client.client_name,
      clientSecret: client.client_secret,
      redirectURIs: client.redirect_uris,
    };
  });

const superadminListOAuthClients = os.superadmin.oauth.listClients
  .use(superadminOnlyMiddleware)
  .handler(async ({ context }) => {
    const clients = await context.db.query.oauthClient.findMany({
      where: and(eq(schema.oauthClient.disabled, false), isNull(schema.oauthClient.userId)),
      orderBy: desc(schema.oauthClient.createdAt),
    });

    return clients.map((client) => ({
      clientId: client.clientId,
      clientName: client.name ?? "",
      redirectURIs: client.redirectUris,
    }));
  });

export const superadmin = os.superadmin.router({
  oauth: {
    createClient: superadminCreateOAuthClient,
    listClients: superadminListOAuthClients,
  },
});

import { ORPCError } from "@orpc/server";
import { os, superadminOnlyMiddleware } from "../orpc.ts";
import { parseStringArray } from "../../db/helpers.ts";
import { listSystemOAuthClients } from "../../db/queries/index.ts";
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
    const clients = await listSystemOAuthClients(context.db);

    return clients.map((client) => ({
      clientId: client.clientId,
      clientName: client.name ?? "",
      redirectURIs: parseStringArray(client.redirectUrisJson),
    }));
  });

export const superadmin = os.superadmin.router({
  oauth: {
    createClient: superadminCreateOAuthClient,
    listClients: superadminListOAuthClients,
  },
});

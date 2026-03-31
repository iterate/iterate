import { oc, type ContractRouterClient } from "@orpc/contract";
import { z } from "zod";

export const CreateClientInput = z.object({
  clientName: z.string().min(1),
  redirectURIs: z.array(z.url()).min(1),
});
export type CreateClientInput = z.infer<typeof CreateClientInput>;

export const OAuthClientRecord = z.object({
  clientId: z.string(),
  clientName: z.string(),
  clientSecret: z.string(),
  redirectURIs: z.array(z.url()),
});
export type OAuthClientRecord = z.infer<typeof OAuthClientRecord>;

export const authContract = oc.router({
  superadmin: {
    oauth: {
      createClient: oc
        .route({
          method: "POST",
          path: "/superadmin/oauth/create-client",
          summary: "Create a new OAuth client",
          tags: ["superadmin", "oauth"],
        })
        .input(CreateClientInput)
        .output(OAuthClientRecord),
      listClients: oc
        .route({
          method: "GET",
          path: "/superadmin/oauth/list-clients",
          summary: "List all OAuth clients",
          tags: ["superadmin", "oauth"],
        })
        .output(z.array(OAuthClientRecord.omit({ clientSecret: true }))),
    },
  },
});
export type AuthContractClient = ContractRouterClient<typeof authContract>;

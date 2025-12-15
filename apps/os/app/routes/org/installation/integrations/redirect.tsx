import { eq } from "drizzle-orm";
import { z } from "zod";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { schema } from "../../../../../backend/db/client.ts";
import { BaseOAuthState } from "../../../../../backend/auth/oauth-state-schemas.ts";
import { authenticatedServerFn } from "../../../../lib/auth-middleware.ts";

const integrationRedirect = authenticatedServerFn
  .inputValidator(z.object({ key: z.string() }))
  .handler(async ({ context, data }) => {
    const { key } = data;
    const { db } = context.variables;

    const state = await db.query.verification.findFirst({
      where: eq(schema.verification.identifier, key),
    });

    if (!state || state.expiresAt < new Date()) {
      throw redirect({ to: "/" });
    }

    const parsedState = BaseOAuthState.parse(JSON.parse(state.value));
    if (!parsedState.fullUrl) throw redirect({ to: "/" });

    // fullUrl is an external URL, so we need to use href
    throw redirect({ href: parsedState.fullUrl });
  });

export const Route = createFileRoute(
  "/_auth.layout/$organizationId/$installationId/integrations/redirect",
)({
  validateSearch: z.object({ key: z.string() }),
  loaderDeps: ({ search }) => ({ key: search.key }),
  loader: ({ deps }) => integrationRedirect({ data: { key: deps.key } }),
});

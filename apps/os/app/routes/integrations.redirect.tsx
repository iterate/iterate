import { useEffect } from "react";
import { redirect, useLoaderData } from "react-router";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../../backend/db/client.ts";
import { MCPOAuthState } from "../../backend/auth/oauth-state-schemas.ts";
import type { Route } from "./+types/integrations.redirect";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Redirecting - Iterate Dashboard" },
    {
      name: "description",
      content: "You are being redirected to complete your integration setup",
    },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  if (!key) {
    return redirect("/");
  }
  const state = await getDb().query.verification.findFirst({
    where: eq(schema.verification.identifier, key),
  });
  if (!state || state.expiresAt < new Date()) {
    return redirect("/");
  }

  const parsedState = MCPOAuthState.parse(JSON.parse(state.value));
  return {
    redirectUrl: parsedState.fullUrl,
  };
}

export default function IntegrationsRedirect() {
  const { redirectUrl } = useLoaderData<typeof loader>();

  useEffect(() => {
    if (redirectUrl) {
      window.location.href = redirectUrl;
    }
  }, [redirectUrl]);

  return (
    <div className="flex items-center justify-center min-h-screen">
      <p className="text-muted-foreground">Redirecting...</p>
    </div>
  );
}

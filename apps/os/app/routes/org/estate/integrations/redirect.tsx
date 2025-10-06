import { redirect } from "react-router";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../../../../../backend/db/client.ts";
import { BaseOAuthState } from "../../../../../backend/auth/oauth-state-schemas.ts";
import type { Route } from "./+types/redirect.ts";

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

  const parsedState = BaseOAuthState.parse(JSON.parse(state.value));
  return redirect(parsedState.fullUrl ?? "/");
}

export default function IntegrationsRedirect() {
  return null;
}

/**
 * The tests' controls of the pet shop, at `/__test-controls/*` (GET / lists them): the shop's own
 * provider's here, then the Slack and GitHub fakes' (slack.ts `handleSlackTestControls`, github.ts
 * `handleGithubTestControls`). The one shop serves every concurrent CI run, so each control names
 * what it acts on (an account of a client, a refresh token, an installation) and touches nothing
 * else.
 */
import { z } from "zod";
import { handleGithubTestControls } from "./github.ts";
import { petshopOauth } from "./oauth-provider.ts";
import { handleSlackTestControls } from "./slack.ts";
import type { ShopDeps } from "./state.ts";

/** A request under `/__test-controls/`: the control's answer, or a 404 for no control. */
export async function handleTestControls(request: Request, deps: ShopDeps): Promise<Response> {
  const key = `${request.method} ${new URL(request.url).pathname}`;
  const body = () => request.json().catch(() => null);
  const invalid = (error_description: string) =>
    Response.json({ error: "invalid_request", error_description }, { status: 400 });
  if (key === "POST /__test-controls/clients")
    return Response.json(await deps.state.createClient({}), { status: 201 });
  if (key === "POST /__test-controls/expire-tokens") {
    const input = ExpireTokens.safeParse(await body());
    if (!input.success)
      return invalid("clientId and account are required, so expiry ends no other test's tokens");
    const { clientId, account } = input.data;
    return Response.json({
      clientId,
      account,
      accessTokenEpoch: await deps.state.expireAccessTokens(clientId, account),
    });
  }
  if (key === "POST /__test-controls/revoke-refresh-token") {
    const input = RevokeRefreshToken.safeParse(await body());
    if (!input.success || !(await petshopOauth(deps).revokeRefreshToken(input.data.refreshToken)))
      return invalid("refreshToken must be a refresh token of the shop's own provider");
    return Response.json({ revoked: true });
  }
  if (key === "POST /__test-controls/fail-token-endpoint") {
    const input = FailTokenEndpoint.safeParse(await body());
    if (!input.success)
      return invalid(
        "clientId (so failures cannot affect unrelated tests) and times, a non-negative integer, are required",
      );
    await deps.state.setTokenEndpointFailures(input.data.clientId, input.data.times);
    return Response.json({
      clientId: input.data.clientId,
      tokenEndpointFailuresRemaining: input.data.times,
    });
  }
  return (
    (await handleSlackTestControls(request, deps)) ??
    (await handleGithubTestControls(request, deps)) ??
    Response.json({ error: "not_found" }, { status: 404 })
  );
}

const ExpireTokens = z.object({ clientId: z.string().min(1), account: z.string().min(1) });
const RevokeRefreshToken = z.object({ refreshToken: z.string() });
const FailTokenEndpoint = z.object({ clientId: z.string().min(1), times: z.int().nonnegative() });

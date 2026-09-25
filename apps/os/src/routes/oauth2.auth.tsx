import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ConsentCard } from "../components/consent/consent-card.tsx";
import { IdentifyCard } from "../components/consent/identify-card.tsx";
import { InvalidRequest } from "../components/consent/invalid-request.tsx";
import { approveConsentForm } from "../consent-page.server.ts";
import { getConsent } from "../issuer.functions.ts";
import { issuerRequestContext } from "../issuer-request-context.server.ts";

// The OAuth authorization endpoint's page. The router hands it the raw query as `authorization`
// (router.tsx); a browser without an issuer session is sent to sign in and back.
export const Route = createFileRoute("/oauth2/auth")({
  validateSearch: z.object({ authorization: z.string().catch("") }),
  // The description decides whether the page renders at all — it redirects to sign-in, or back to
  // the client — so it runs before the route's code loads. Thrown from a loader, the redirect would
  // end the request with the page's component chunk still loading, and the router keeps that
  // promise on the route: the next render in the isolate would wait for it forever.
  beforeLoad: async ({ search }) => ({ consent: await getConsent({ data: search }) }),
  loader: ({ context }) => context.consent,
  head: ({ loaderData }) => ({
    meta: [
      {
        title:
          loaderData?.view.kind === "consent"
            ? `Authorize ${loaderData.view.clientName} — iterate`
            : loaderData?.view.kind === "identify"
              ? `Confirm it's you — iterate`
              : "Invalid authorization request — iterate",
      },
    ],
  }),
  server: {
    handlers: {
      POST: ({ request }) => {
        const { env, ctx } = issuerRequestContext();
        return approveConsentForm(request, env, ctx);
      },
    },
  },
  component: AuthorizePage,
});

function AuthorizePage() {
  const { view, platformOrigin } = Route.useLoaderData();
  const { authorization } = Route.useSearch();
  if (view.kind === "invalid") return <InvalidRequest description={view.description} />;
  if (view.kind === "identify") return <IdentifyCard view={view} />;
  return <ConsentCard view={view} authorization={authorization} platformOrigin={platformOrigin} />;
}

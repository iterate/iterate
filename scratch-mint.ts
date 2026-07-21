/** Scratch (not committed): re-mint a session cookie for the demo project. */
import { mintIterateSession } from "./specs/test-support/forged-session.ts";

const baseUrl = "http://localhost:51705";
const project = { id: "prj_880f6e6dbbdf4f74a6db5a53dd2e4c4e", slug: "demo-dash-3ame" };
const organization = {
  id: `org_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
  name: "Demo Org",
  role: "admin" as const,
  slug: "demo-dash-3ame-org",
};
const session = await mintIterateSession({
  baseUrl,
  email: "forged-demo-dash-3ame+test@nustom.com",
  organizations: [organization],
  projects: [{ ...project, organizationId: organization.id }],
});
console.log(
  JSON.stringify({
    expires: Math.floor(session.expiresAtMs / 1000),
    cookie: encodeURIComponent(
      JSON.stringify({
        accessToken: session.accessToken,
        accessTokenExpiresAt: session.expiresAtMs,
        idToken: session.idToken,
        tokenType: "bearer",
      }),
    ),
  }),
);

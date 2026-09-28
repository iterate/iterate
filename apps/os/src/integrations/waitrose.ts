// src/integrations/waitrose.ts — WAITROSE's login, the platform's bundled exchange code: the same
// shape as a secret's own (`refresh: { kind: "worker", source }`, secret/exchange-jail.ts) —
// `exchange(material, fetch)` answers the NEXT material — with the one thing a bundled kind adds, the
// endpoint its strategy names (`{ kind: "waitrose-session", graphqlUrl }`). It runs in the secret's
// facet (secrets.ts `refreshSecretMaterial`) with the facet's pinned dispatch as `fetch`. A
// connection is a secret `/secrets/waitrose-<connection>` holding `{ username, password }` and a
// platform `waitrose/connected` naming the username (waitrose-connection.ts).
// Only erasable TypeScript syntax: secrets.ts, which a type-stripping loader takes, imports it.
import { z } from "zod";
import type { SecretMaterial } from "iterate/api";

/** The Waitrose Android app's login mutation, retained verbatim. */
const WAITROSE_NEW_SESSION_MUTATION =
  "mutation NewSession($input: SessionInput) { generateSession(session: $input) { __typename ...SessionPayload failures { type message } } }  fragment SessionPayload on SetSessionPayload { accessToken refreshToken customerId customerOrderId customerOrderState defaultBranchId expiresIn }";

/** The credential a Waitrose secret holds; anything else in it is kept as it is. */
const WaitroseMaterial = z.looseObject({
  username: z.string().min(1),
  password: z.string().min(1),
});

/** `{ data: { generateSession: { accessToken, failures } } }`, each level optional: a missing one
 *  falls through to the "returned no accessToken" refusal. */
const NewSessionAnswer = z.object({
  data: z
    .object({
      generateSession: z
        .object({
          accessToken: z.string().nullish(),
          failures: z.array(z.object({ type: z.string() })).nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

/** Log in with the material's `username` and `password` → the material with a fresh `accessToken`.
 *  Waitrose has no refresh grant: re-login IS the refresh. A refusal names the fix and never the
 *  credential. */
export async function exchange(
  material: SecretMaterial | null,
  fetch: (request: Request) => Promise<Response>,
  options: { graphqlUrl: string },
): Promise<Record<string, unknown>> {
  const credential = WaitroseMaterial.safeParse(material);
  if (!credential.success)
    throw new Error('waitrose-session: the secret\'s material has no "username" and "password"');
  const { username, password } = credential.data;
  const response = await fetch(
    new Request(options.graphqlUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        // Waitrose's edge answers UA-less requests with HTTP 520;
        // the Android app's UA is the known-good request shape.
        "user-agent": "Waitrose/3.9.1 (Android)",
      },
      body: JSON.stringify({
        query: WAITROSE_NEW_SESSION_MUTATION,
        variables: { input: { clientId: "ANDROID_APP", password, username } },
      }),
    }),
  );
  // The live API answers wrong credentials with a 401; the app-client contract is a 200 with a
  // failures[] — read both.
  if (response.status === 401)
    throw new Error(
      "waitrose-session: login refused (HTTP 401) — check the secret's username/password",
    );
  if (!response.ok) throw new Error(`waitrose-session: login answered HTTP ${response.status}`);
  const answer = NewSessionAnswer.safeParse(await response.json().catch(() => null));
  const session = answer.data?.data?.generateSession;
  const failure = session?.failures?.[0]?.type;
  if (failure) throw new Error(`waitrose-session: login refused (${failure})`);
  if (!session?.accessToken) throw new Error("waitrose-session: login returned no accessToken");
  return { ...credential.data, accessToken: session.accessToken };
}

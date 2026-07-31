import { NodeServices } from "@effect/platform-node";
import { ITERATE_ROLE_CLAIM } from "@iterate-com/shared/auth-claims";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { envManagerEnv } from "../../envs.ts";

const SyncServiceToken = Alchemy.Action(
  "SyncServiceToken",
  (input: { clientId: string; clientSecret: Redacted.Redacted<string> | undefined }) =>
    Effect.gen(function* () {
      if (input.clientSecret === undefined) {
        return yield* Effect.fail(
          new Error("Cloudflare did not return the Access service-token secret."),
        );
      }

      const spawner = yield* ChildProcessSpawner;
      const secrets = {
        CLOUDFLARE_ACCESS_CLIENT_ID: input.clientId,
        CLOUDFLARE_ACCESS_CLIENT_SECRET: Redacted.value(input.clientSecret),
      };
      for (const [name, value] of Object.entries(secrets)) {
        const exitCode = yield* spawner.exitCode(
          ChildProcess.make(
            "doppler",
            [
              "secrets",
              "set",
              name,
              "--project",
              "env-manager",
              "--config",
              envManagerEnv.dopplerConfig,
              "--no-interactive",
            ],
            {
              stdin: Stream.succeed(new TextEncoder().encode(value)),
              stdout: "ignore",
              stderr: "inherit",
            },
          ),
        );
        if (Number(exitCode) !== 0) {
          return yield* Effect.fail(
            new Error(`Failed to store ${name} in env-manager/${envManagerEnv.dopplerConfig}.`),
          );
        }
      }

      return { clientId: input.clientId };
    }).pipe(Effect.provide(NodeServices.layer)),
);

const issuer = `${envManagerEnv.authBaseUrl}/api/auth`;

export default Alchemy.Stack(
  "EnvironmentManagerAccess",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const oidcClientId = yield* Config.string("CLOUDFLARE_ACCESS_OIDC_CLIENT_ID");
    const oidcClientSecret = yield* Config.redacted("CLOUDFLARE_ACCESS_OIDC_CLIENT_SECRET");

    const identityProvider = yield* Cloudflare.Access.IdentityProvider("IterateAuth", {
      name: "Iterate Auth",
      type: "oidc",
      config: {
        clientId: oidcClientId,
        clientSecret: Redacted.value(oidcClientSecret),
        authUrl: `${issuer}/oauth2/authorize`,
        tokenUrl: `${issuer}/oauth2/token`,
        certsUrl: `${issuer}/jwks`,
        scopes: ["openid", "email", "profile"],
        claims: [ITERATE_ROLE_CLAIM],
        emailClaimName: "email",
        pkceEnabled: true,
      },
    });

    const administrators = yield* Cloudflare.Access.Policy("Administrators", {
      name: "Environment manager administrators",
      decision: "allow",
      include: [
        {
          oidc: {
            claimName: ITERATE_ROLE_CLAIM,
            claimValue: "admin",
            identityProviderId: identityProvider.identityProviderId,
          },
        },
      ],
    });

    const serviceToken = yield* Cloudflare.Access.ServiceToken("Cli", {
      name: "Environment manager CLI",
      duration: "8760h",
    });
    const serviceAccess = yield* Cloudflare.Access.Policy("CliPolicy", {
      name: "Environment manager CLI",
      decision: "non_identity",
      include: [{ serviceToken: { tokenId: serviceToken.serviceTokenId } }],
    });

    const application = yield* Cloudflare.Access.Application("Application", {
      name: "Environment manager",
      type: "self_hosted",
      domain: new URL(envManagerEnv.baseUrl).hostname,
      sessionDuration: "24h",
      allowedIdps: [identityProvider.identityProviderId],
      autoRedirectToIdentity: true,
      policies: [serviceAccess.policyId, administrators.policyId],
    });

    yield* SyncServiceToken({
      clientId: serviceToken.clientId,
      clientSecret: serviceToken.clientSecret,
    });

    return {
      applicationId: application.applicationId,
      audience: application.aud,
      identityProviderId: identityProvider.identityProviderId,
      serviceTokenId: serviceToken.serviceTokenId,
    };
  }),
);

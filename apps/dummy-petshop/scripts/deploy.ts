import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { dummyPetshopEnvs, getEnv } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";

/** vite build → wrangler deploy → the shop's index and its state answer (scripts/lib/deploy-app.ts).
 *  The JWKS reads the OIDC key from the state object, so a state object that cannot start fails the
 *  deploy rather than the next suite that calls the shop. No secrets ship: PETSHOP_SEAL_KEY is
 *  already a worker secret, and a deploy keeps it. */
export default async function deploy(options: { env: string }) {
  await deployApp(getEnv(options.env, dummyPetshopEnvs), {
    dopplerProject: "dummy-petshop",
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/dummy-petshop",
    smokes: [
      { url: "/", ok: (response) => response.status === 200, label: "shop index" },
      {
        url: "/cloudflare/.well-known/jwks.json",
        ok: (response) => response.status === 200,
        label: "shop state",
      },
    ],
  });
}

void createCli({ ...import.meta, name: "deploy" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});

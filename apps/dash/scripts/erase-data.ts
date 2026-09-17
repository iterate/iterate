import { createCli } from "trpc-cli";
import { dashEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";

export default async function eraseData(options: { env: string }) {
  const ctx = await resolveEnvContext({
    envs: dashEnvs,
    dopplerProject: "dash",
    env: options.env,
  });
  console.log(
    `${ctx.name}: Dash owns no server data; sessions, projects and organizations belong to the platform.`,
  );
}
if (process.argv[1]?.endsWith("erase-data.ts"))
  void createCli({ ...import.meta, name: "erase-data" }).run();

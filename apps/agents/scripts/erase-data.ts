import { createCli } from "trpc-cli";
import { agentsEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";

export default async function eraseData(options: { env: string }) {
  const ctx = await resolveEnvContext({
    envs: agentsEnvs,
    dopplerProject: "agents",
    env: options.env,
  });
  console.log(`${ctx.name}: Agents owns no server data; agents belong to their projects.`);
}
if (process.argv[1]?.endsWith("erase-data.ts"))
  void createCli({ ...import.meta, name: "erase-data" }).run();

import { createCli } from "trpc-cli";
import { notesEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";

export default async function eraseData(options: { env: string }) {
  const ctx = await resolveEnvContext({
    envs: notesEnvs,
    dopplerProject: "notes",
    env: options.env,
  });
  console.log(`${ctx.name}: Notes owns no server data; notes belong to their projects.`);
}
if (process.argv[1]?.endsWith("erase-data.ts"))
  void createCli({ ...import.meta, name: "erase-data" }).run();

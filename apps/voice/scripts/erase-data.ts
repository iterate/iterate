import { createCli } from "trpc-cli";
import { voiceEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";

export default async function eraseData(options: { env: string }) {
  const ctx = await resolveEnvContext({
    envs: voiceEnvs,
    dopplerProject: "voice",
    env: options.env,
  });
  console.log(`${ctx.name}: Voice owns no server data; calls belong to their projects.`);
}
if (process.argv[1]?.endsWith("erase-data.ts"))
  void createCli({ ...import.meta, name: "erase-data" }).run();

import { buildAgentRuntime } from "../scripts/build-runtime.ts";
import { installAgents } from "../runtime/install.ts";
import { openItx } from "../../os-next/e2e/support/client.ts";

let runtime: Promise<string> | undefined;
export async function openAgentItx(context: string) {
  const itx = openItx(context);
  await installAgents(itx, await (runtime ??= buildAgentRuntime()));
  return itx;
}

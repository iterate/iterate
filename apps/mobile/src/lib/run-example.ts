// Runs one catalogue example against a project, from the phone — the exact
// server-side script isolate agents use (capabilityHost.runScript), not
// local JS eval. The envelope/lookup logic itself lives in
// apps/os/src/itx/run-example.ts, shared with the e2e examples matrix, so
// the phone runs the exact same thing proven there.
//
// Takes an already-dialed session rather than dialing itself (Expo-free, so
// the live e2e drives this exact function from Node — same seam split as
// itx-core.ts/itx.ts): the UI screen supplies its Expo-backed session via
// itx.ts, the e2e supplies a forge-bearer one via itx-core.ts's dialItx.

import { runExample } from "../../../os/src/itx/run-example.ts";
import type { ItxSession } from "./itx-core.ts";

export async function runMobileExample(
  itx: ItxSession,
  projectId: string,
  exampleId: string,
): Promise<unknown> {
  const project = await itx.projects.get(projectId);
  return await runExample(exampleId, { capabilityHost: project.capabilityHost });
}

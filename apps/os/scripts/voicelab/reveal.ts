// Print a project's own ingress key, which is what a device or the host CLI
// authenticates with.
//
// Every other secret in a project is write-only; this one is born readable
// precisely so it can be handed to something outside the platform. It is the
// only credential the voice client needs, and printing it is the supported
// way to get it — see docs/remote-apps.md.
import { connectProject, type VoicelabConnectOptions } from "./connect.ts";

/** Options for `pnpm cli voicelab reveal`. */
export interface RevealOptions extends VoicelabConnectOptions {}

export async function reveal(options: RevealOptions) {
  const itx = await connectProject(options);
  const material = await itx.secrets.get("/secrets/project-api-key").reveal();
  if (typeof material !== "string" || material.length === 0) {
    throw new Error(
      "the project ingress key is not readable — every project is born with " +
        "one at /secrets/project-api-key, so an unreadable one means this is " +
        "not the project you think it is",
    );
  }
  // stdout only, so a caller can `KEY=$(… reveal)` without stripping noise.
  console.log(material);
}

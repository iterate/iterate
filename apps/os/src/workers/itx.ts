/**
 * itx context worker: hosts the generic extended-context Durable Objects
 * (one per child context, addressed by journal coordinate). Contexts dial
 * capabilities, so this worker re-exports the full loopback surface.
 */
export { ItxDurableObject } from "~/itx/itx-durable-object.ts";
export * from "./shared/loopback-exports.ts";

export default {
  fetch: () => Response.json({ worker: "os-itx" }, { status: 404 }),
};

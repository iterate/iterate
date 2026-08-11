// The MediaApp's physical identity: a stable durable key preserves its
// processor storage across implementation updates. The literal lives in
// ref.ts (dependency-free for the mobile e2e); this module holds the
// satisfies check against the real ref type.
import type { StatefulDynamicWorkerRef } from "../../sdk.ts";
import { mediaWorkerRef as mediaWorkerRefLiteral } from "./ref.ts";

export { mediaStreamPath } from "./ref.ts";

export const mediaWorkerRef = mediaWorkerRefLiteral satisfies StatefulDynamicWorkerRef;

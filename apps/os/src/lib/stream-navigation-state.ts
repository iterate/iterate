import type { z } from "zod";
import { StreamState } from "@iterate-com/shared/streams/types";

// Lenient view of stream state for navigation UIs (tree browsers, breadcrumbs).
//
// Do NOT "simplify" this back to StreamState: StreamState's `processors` schema
// does not match what stream Durable Objects actually persist (e.g. real
// external-subscriber entries carry `via: { type: "legacy-do-binding" }` and no
// `schema`), so StreamState.parse throws on real state — that parse failure is
// the bug this schema fixed. Navigation only needs the tree shape, so we omit
// `processors` (z.object strips the unknown key on parse). See
// stream-navigation-state.test.ts for a captured real-world example.
export const StreamNavigationState = StreamState.omit({ processors: true });
export type StreamNavigationState = z.infer<typeof StreamNavigationState>;

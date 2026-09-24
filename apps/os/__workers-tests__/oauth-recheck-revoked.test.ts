// A grant revoked on the person's account while their session is live. Its own file: the row waits
// the guard's real 30 s re-check, beside the other three (oauth-support.ts).
import { test } from "vitest";
import { liveSessionLosesHeldCapabilities } from "./oauth-support.ts";

test("a live session loses held capabilities after revoked within 60 seconds", () =>
  liveSessionLosesHeldCapabilities("revoked"));

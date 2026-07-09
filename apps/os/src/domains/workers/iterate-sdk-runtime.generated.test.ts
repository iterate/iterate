// Guards the generated `iterate/sdk` runtime bundle: dynamic workers resolve
// their import from this embedded module, which must track
// packages/iterate/src exactly. Rebuilds with the same pinned esbuild recipe
// and compares byte-for-byte — a mismatch means someone changed the SDK
// source without running pnpm generate:iterate-sdk-runtime.
import { expect, test } from "vitest";
import { buildIterateSdkRuntimeModule } from "../../../scripts/iterate-sdk-runtime-bundle.ts";
import { ITERATE_SDK_RUNTIME_MODULE } from "./iterate-sdk-runtime.generated.ts";

test("iterate-sdk-runtime.generated.ts is fresh (pnpm generate:iterate-sdk-runtime)", async () => {
  expect(ITERATE_SDK_RUNTIME_MODULE).toBe(await buildIterateSdkRuntimeModule());
});

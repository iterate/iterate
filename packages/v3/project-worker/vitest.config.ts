// Tests run through the capnweb-validate Vite plugin so any test that imports a
// @validateRpc()-decorated class exercises the TRANSFORMED code (an untransformed decorator
// throws at class-definition time by design) — the cloudflare-os vitest wiring.
import { defineConfig } from "vitest/config";
import capnwebValidate from "capnweb-validate/vite";

export default defineConfig({
  plugins: [capnwebValidate()],
  // src only — the .wrangler/validate mirror carries byte-copies of the tests too.
  test: { include: ["src/**/*.test.ts"] },
});

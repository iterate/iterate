import { expect, test, vi } from "vitest";
import { deployedTarget } from "./deployed-target.ts";

test("a deployed target supplies its known origin beside its Doppler secrets", () => {
  using _env = { [Symbol.dispose]: () => vi.unstubAllEnvs() };
  vi.stubEnv(
    "APP_CONFIG",
    JSON.stringify({ login: { password: "p" }, secrets: { adminBearer: "bearer" } }),
  );
  vi.stubEnv("APP_CONFIG_SECRETS__KEY", "key");

  expect(deployedTarget("https://pr3144-a1b2c3d-os.iterate-dev-preview.workers.dev")).toMatchObject(
    {
      adminBearer: "bearer",
      loginPassword: "p",
      ingressRouting: JSON.stringify({ type: "paths" }),
    },
  );
});

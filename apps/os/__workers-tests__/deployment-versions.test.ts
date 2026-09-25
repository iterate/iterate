// __workers-tests__/deployment-versions.test.ts — `session.versions` (src/session.ts), the deploy's
// readiness gate's view (scripts/preview-readiness.ts): the version the edge and each named project's
// root context run, the operator's alone. One worker here, so every answer names its one version; a
// preview mid-release is what the gate itself measures.
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { appConfigOf } from "../src/app-config.ts";
import { adminCredentials, openSession, refused, signedInSession } from "./support.ts";

test("session.versions names the version the edge and each named project's root context run — the operator's alone", async () => {
  const running = appConfigOf(env).deployId;
  const admin = (await openSession()).authenticate(adminCredentials());
  expect(await admin.versions(["prj_versions_a", "prj_versions_b"])).toEqual({
    edge: running,
    contexts: [running, running],
  });
  await refused(() => admin.versions(["prj_versions.iterate/agents"]), "INVALID_CONTEXT");
  // the operator acting as a person is that person: refused, like a signed-in person
  const actingAs = (await openSession()).authenticate({
    ...adminCredentials(),
    as: { email: "acting-as@versions.test" },
  });
  await refused(() => actingAs.versions([]), "FORBIDDEN");
  const person = await signedInSession("person@versions.test");
  await refused(() => person.versions([]), "FORBIDDEN");
});

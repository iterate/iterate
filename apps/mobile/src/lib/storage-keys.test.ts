import { expect, test } from "vitest";
import { lastProjectStorageKey } from "./storage-keys.ts";

test("remembered projects are scoped to the deployment and interactive auth context", () => {
  const previewEight = lastProjectStorageKey("https://os.iterate-preview-8.com", {
    issuer: "https://auth.iterate-preview-8.com/api/auth",
    clientId: "client-alice",
  });

  expect(previewEight).not.toBe(
    lastProjectStorageKey("https://os.iterate-preview-8.com", {
      issuer: "https://auth.iterate-preview-8.com/api/auth",
      clientId: "client-bob",
    }),
  );
  expect(previewEight).not.toBe(
    lastProjectStorageKey("https://os.iterate.com", {
      issuer: "https://auth.iterate.com/api/auth",
      clientId: "client-alice",
    }),
  );
});

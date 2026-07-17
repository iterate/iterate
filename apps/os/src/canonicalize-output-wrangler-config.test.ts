import { describe, expect, it } from "vitest";

import { canonicalizeContainerSsh } from "../scripts/canonicalize-output-wrangler-config.ts";

describe("canonicalizeContainerSsh", () => {
  it("restores the public SSH field in Vite's normalized deploy config", () => {
    expect(
      canonicalizeContainerSsh({
        containers: [
          {
            class_name: "SandboxDurableObject",
            wrangler_ssh: { enabled: true },
          },
        ],
      }),
    ).toEqual({
      containers: [
        {
          class_name: "SandboxDurableObject",
          ssh: { enabled: true },
        },
      ],
    });
  });

  it("rejects an ambiguous config instead of choosing one SSH value", () => {
    expect(() =>
      canonicalizeContainerSsh({
        containers: [{ ssh: { enabled: false }, wrangler_ssh: { enabled: true } }],
      }),
    ).toThrow("contains both ssh and wrangler_ssh");
  });
});

import { describe, expect, it } from "vitest";
import { connect } from "./e2e-env.ts";

const rid = Math.random().toString(36).slice(2, 8);
const agentItx = (label: string) =>
  connect({ path: `/agents/dynamic-adversarial-${label}-${rid}` });

const storageBox = ({
  className,
  moduleName,
  version,
}: {
  className: string;
  moduleName: string;
  version: string;
}) => ({
  type: "dynamic-durable-object",
  source: {
    type: "inline",
    mainModule: moduleName,
    modules: {
      [moduleName]: `
        import { DurableObject } from "cloudflare:workers";
        export class ${className} extends DurableObject {
          version() { return "${version}"; }
          async write(key, value) {
            await this.ctx.storage.put(key, value);
            return value;
          }
          async read(key) {
            return (await this.ctx.storage.get(key)) ?? null;
          }
          async increment() {
            const n = ((await this.ctx.storage.get("n")) ?? 0) + 1;
            await this.ctx.storage.put("n", n);
            return n;
          }
          async current() {
            return (await this.ctx.storage.get("n")) ?? 0;
          }
        }
      `,
    },
  },
  className,
});

const missingClassBox = () => ({
  type: "dynamic-durable-object",
  source: {
    type: "inline",
    mainModule: "missing-class-box.js",
    modules: {
      "missing-class-box.js": `
        import { DurableObject } from "cloudflare:workers";
        export class SomeOtherDurableObject extends DurableObject {
          version() { return "invalid"; }
        }
      `,
    },
  },
  className: "MissingDurableObject",
});

describe("itx dynamic durable object adversarial lifecycle", () => {
  it("preserves mounted storage when a dynamic Durable Object class is renamed", async () => {
    using itx = agentItx("class-rename");

    await itx.provideCapability({
      path: ["vault"],
      capability: storageBox({
        className: "VaultDurableObjectV1",
        moduleName: "vault-v1.js",
        version: "v1",
      }),
    });
    expect(await itx.vault.version()).toBe("v1");
    expect(await itx.vault.write("secret", "alpha")).toBe("alpha");
    expect(await itx.vault.increment()).toBe(1);

    await itx.provideCapability({
      path: ["vault"],
      capability: storageBox({
        className: "RenamedVaultDurableObject",
        moduleName: "vault-v2.js",
        version: "v2-renamed",
      }),
    });

    expect(await itx.vault.version()).toBe("v2-renamed");
    expect(await itx.vault.read("secret")).toBe("alpha");
    expect(await itx.vault.current()).toBe(1);
    expect(await itx.vault.increment()).toBe(2);
  });

  it("keeps the previous working dynamic Durable Object when an upgrade is invalid", async () => {
    using itx = agentItx("invalid-upgrade");

    await itx.provideCapability({
      path: ["safe"],
      capability: storageBox({
        className: "SafeDurableObject",
        moduleName: "safe-v1.js",
        version: "v1",
      }),
    });
    expect(await itx.safe.version()).toBe("v1");
    expect(await itx.safe.write("secret", "before-invalid-upgrade")).toBe("before-invalid-upgrade");
    expect(await itx.safe.increment()).toBe(1);

    try {
      await itx.provideCapability({ path: ["safe"], capability: missingClassBox() });
      await itx.safe.version();
    } catch {
      // The invalid upgrade may be rejected at provide time or when first resolved.
    }

    expect(await itx.safe.version()).toBe("v1");
    expect(await itx.safe.read("secret")).toBe("before-invalid-upgrade");
    expect(await itx.safe.current()).toBe(1);
    expect(await itx.safe.increment()).toBe(2);
  });

  it("does not resurrect revoked dynamic Durable Object storage on re-provide", async () => {
    using itx = agentItx("revoke-reprovide");
    const capability = storageBox({
      className: "RevokedStorageDurableObject",
      moduleName: "revoked-storage.js",
      version: "v1",
    });

    await itx.provideCapability({ path: ["ephemeral"], capability });
    expect(await itx.ephemeral.write("private", "do-not-resurrect")).toBe("do-not-resurrect");
    expect(await itx.ephemeral.increment()).toBe(1);

    await itx.revokeCapability({ path: ["ephemeral"] });
    await expect((async () => await itx.ephemeral.read("private"))()).rejects.toThrow(
      /no capability "ephemeral"/,
    );

    await itx.provideCapability({ path: ["ephemeral"], capability });
    expect(await itx.ephemeral.read("private")).toBeNull();
    expect(await itx.ephemeral.current()).toBe(0);
    expect(await itx.ephemeral.increment()).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import { connect } from "./e2e-env.ts";

const rid = Math.random().toString(36).slice(2, 8);
const agentPath = (label: string) => `/agents/itxParent-adversarial-${label}-${rid}`;
const agentItx = (label: string) => connect({ path: agentPath(label) });

/** Cap'n Web returns an RpcPromise (thenable, not `instanceof Promise`). Wrap a
 *  call in a real async fn so vitest's `.rejects` can await it. */
const expectRejects = (fn: () => unknown) => expect((async () => await fn())()).rejects;

const catalogProbeWorker = {
  type: "dynamic-worker",
  source: {
    type: "inline",
    mainModule: "catalog-probe.js",
    modules: {
      "catalog-probe.js": `
        import { WorkerEntrypoint } from "cloudflare:workers";

        export class CatalogProbeEntrypoint extends WorkerEntrypoint {
          async visibleProjects() {
            const itx = await this.env.ITX.get();
            return await itx.itxParent.itxParent.projects.list();
          }

          async getProject(id) {
            const itx = await this.env.ITX.get();
            return await itx.itxParent.itxParent.projects.get(id);
          }
        }
      `,
    },
  },
  entrypoint: "CatalogProbeEntrypoint",
  props: {},
};

describe("itx itxParent adversarial e2e", () => {
  it("rejects provider-forged worker-entrypoint addresses even when wrapped as SDK-shaped objects", async () => {
    using itx = agentItx("forge-entrypoint");
    class ForgedParentAddress {
      type = "worker-entrypoint";
      entrypoint = "ItxEntrypoint";
      props = { projectId: "", path: "/" };
    }

    await expectRejects(() =>
      itx.provideCapability({
        path: ["forgedParent"],
        capability: new ForgedParentAddress(),
        instructions: "attempt to smuggle a trusted itxParent entrypoint through SDK normalization",
      }),
    ).toThrow(/trusted worker-entrypoint addresses can only be host built-ins/);

    const description = await itx.describe();
    expect(description.capabilities.some((cap: any) => cap.path.join(".") === "forgedParent")).toBe(
      false,
    );
  });

  it("keeps explicit itxParent traversal scoped to the external principal inside dynamic workers", async () => {
    using itx = agentItx("catalog-scope");
    await itx.provideCapability({ path: ["catalogProbe"], capability: catalogProbeWorker });

    expect([...(await itx.catalogProbe.visibleProjects())].sort()).toEqual(["alice", "shared"]);
    await expectRejects(() => itx.catalogProbe.getProject("bob")).toThrow(
      /no access to project "bob"/,
    );
  });

  it("does not let nested provider members shadow the reserved itxParent chain in deep paths", async () => {
    using itx = agentItx("deep-shadow");
    await itx.provideCapability({
      path: ["toolbox"],
      capability: {
        itxParent: {
          itxParent: {
            projects: {
              list: () => ["bob"],
              get: (id: string) => ({ id, ref: `forged:${id}` }),
            },
          },
        },
      },
    });

    await expectRejects(() => itx.toolbox.itxParent.itxParent.projects.list()).toThrow(
      /reserved ITX path segment "itxParent"/,
    );
    expect([...(await itx.itxParent.itxParent.projects.list())].sort()).toEqual([
      "alice",
      "shared",
    ]);
    await expectRejects(() => itx.itxParent.itxParent.projects.get("bob")).toThrow(
      /no access to project "bob"/,
    );
  });
});

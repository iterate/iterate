// npm-packages.e2e.test.ts — a loaded worker imports packages BY NAME, with no build step, against the
// deployment: its source is TypeScript files and a package.json, the loader resolves every bare import
// from npm through esm.sh (context/module-resolution.ts) and locks the graph in KV, and the worker's
// own fetches leave through the project's egress. Two rows, one per way a dependency is named:
//   • an npm range: hono routes the request, @iterate-com/capnweb's HTTP batch calls the pet shop;
//   • a vendor's SDK from pkg.pr.new: @iterate-com/petshop-sdk (packages/petshop-sdk) — the PR's own
//     build when the PR published one (it changed the SDK), else main's — the typed client a vendor
//     would ship, used from typed TypeScript.
// Both answer the pet shop's catalogue for the shopper whose bearer the request carries: the seeded
// pets, and whatever the suite's other pet-shop rows added meanwhile.
import { expect, test } from "vitest";
import { openItx, runId } from "./support/client.ts";
import {
  fetchProjectUrl,
  freshDnsSafeProjectSlug,
  projectUrl,
  publishConfigWorker,
  registerProject,
} from "./support/project-host.ts";
import { petshopBaseUrl, petshopLegacyBearer } from "./support/petshop.ts";

test("a loaded worker imports npm packages by name: hono routes, @iterate-com/capnweb calls the pet shop through egress", async () => {
  const pets = await petsFrom({
    slug: "npm-hono",
    files: {
      "package.json": JSON.stringify({
        dependencies: { hono: "^4", "@iterate-com/capnweb": "^0.12.2" },
      }),
      "worker.ts": `
        import { Hono } from "hono";
        import { newHttpBatchRpcSession } from "@iterate-com/capnweb";

        type Shop = { listPets(): { owner: string; pets: { id: string; name: string }[] } };

        const app = new Hono();
        // Any path: under paths routing the worker sees /projects/<project>/pets/, verbatim.
        app.get("*", async (c) => {
          using shop = newHttpBatchRpcSession<Shop>(
            new Request(\`\${c.req.header("x-petshop-base")}/capnweb\`, {
              headers: { Authorization: \`Bearer \${c.req.header("x-petshop-token")}\` },
            }),
          );
          const { owner, pets } = await shop.listPets();
          return c.json({ via: "hono", owner, names: pets.map((pet) => pet.name) });
        });
        export default app;
      `,
    },
  });
  expect(pets).toMatchObject({ via: "hono", names: expect.arrayContaining(["Biscuit", "Goldie"]) });
});

test("a vendor's SDK from pkg.pr.new: @iterate-com/petshop-sdk, typed, lists the shopper's pets", async () => {
  const sdkAt = (ref: string) =>
    `https://pkg.pr.new/iterate/iterate/@iterate-com/petshop-sdk@${ref}`;
  const pr = process.env.PREVIEW_PR_NUMBER?.trim();
  const version = pr && (await fetch(sdkAt(pr), { method: "HEAD" })).ok ? sdkAt(pr) : sdkAt("main");
  const pets = await petsFrom({
    slug: "npm-vendor",
    files: {
      "package.json": JSON.stringify({
        dependencies: {
          "@iterate-com/petshop-sdk": version,
        },
      }),
      "worker.ts": `
        import { WorkerEntrypoint } from "cloudflare:workers";
        import { connectPetshop, type Pet } from "@iterate-com/petshop-sdk";

        export default class extends WorkerEntrypoint {
          async fetch(request: Request): Promise<Response> {
            using shop = connectPetshop({
              token: request.headers.get("x-petshop-token") ?? "",
              baseUrl: request.headers.get("x-petshop-base") ?? undefined,
            });
            const { owner, pets }: { owner: string; pets: Pet[] } = await shop.listPets();
            return Response.json({ via: "petshop-sdk", owner, names: pets.map((pet) => pet.name) });
          }
        }
      `,
    },
  });
  expect(pets).toMatchObject({
    via: "petshop-sdk",
    names: expect.arrayContaining(["Biscuit", "Goldie"]),
  });
});

/** Publish `files` as a fresh project's config worker and GET it (routing slug `pets`) with a live pet-shop bearer
 *  for a shopper of its own; the shop's answer, as the worker relays it, owner checked. */
async function petsFrom({ slug, files }: { slug: string; files: Record<string, string> }) {
  const project = freshDnsSafeProjectSlug(slug);
  const itx = openItx(await registerProject(project));
  await publishConfigWorker(itx, ["itx", "workers", ["get", { source: files }]]);
  const owner = `${slug}-${runId()}@example.com`;
  const response = await fetchProjectUrl(projectUrl({ project, routingSlug: "pets", path: "/" }), {
    "x-petshop-base": petshopBaseUrl(),
    "x-petshop-token": await petshopLegacyBearer(owner),
  });
  expect(response, response.text).toMatchObject({ status: 200 });
  const pets = JSON.parse(response.text) as { via: string; owner: string; names: string[] };
  expect(pets).toMatchObject({ owner });
  return pets;
}

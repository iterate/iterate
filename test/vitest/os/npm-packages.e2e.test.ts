// npm-packages.e2e.test.ts — a loaded worker imports packages BY NAME, with no build step, against the
// deployment: its source is TypeScript files and a package.json, the loader resolves every bare import
// from npm through esm.sh (context/module-resolution.ts) and locks the graph in KV, and the worker's
// own fetches leave through the project's egress. One row per way a dependency is named:
//   • an npm range: hono routes the request, @iterate-com/capnweb's HTTP batch calls the pet shop;
//   • a vendor's SDK from pkg.pr.new: @iterate-com/petshop-sdk (packages/petshop-sdk) — the PR's own
//     build when the PR published one (it changed the SDK), else main's, pinned at its commit as
//     every writer pins one — the typed client a vendor would ship, used from typed TypeScript;
//   • an npm alias of a platform package: zod 3 as `zod3`, beside the deployment's own zod.
// The first two answer the pet shop's catalogue for the shopper whose bearer the request carries:
// the seeded pets, and whatever the suite's other pet-shop rows added meanwhile.
import { isPkgPrNewCommit, pinPkgPrNewVersion, pkgPrNewVersion } from "iterate/pkg-pr-new";
import { expect, test } from "vitest";
import { openItx, runId } from "../../helpers/client.ts";
import { publishConfigWorker } from "../../helpers/config-worker.ts";
import {
  fetchProjectUrl,
  freshDnsSafeProjectSlug,
  projectUrl,
  registerProject,
} from "../../helpers/project-host.ts";
import { petshopBaseUrl, petshopLegacyBearer } from "../../helpers/petshop.ts";

test("a loaded worker imports npm packages by name: hono routes, @iterate-com/capnweb calls the pet shop through egress", async () => {
  const pets = await petsFrom({
    slug: "npm-hono",
    files: {
      "package.json": JSON.stringify({
        main: "worker.ts",
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
  const sdkAt = (ref: string) => pkgPrNewVersion("@iterate-com/petshop-sdk", ref);
  const pr = process.env.PREVIEW_PR_NUMBER?.trim();
  // The PR's own build answers with its commit. A number the PR published nothing under is a 404,
  // or a 200 for another build pkg.pr.new matched to it, which names no commit: main's, then.
  const prBuild = pr ? await fetch(sdkAt(pr), { method: "HEAD" }) : undefined;
  const prCommit = prBuild?.ok ? prBuild.headers.get("x-commit-key")?.split(":").at(-1) : undefined;
  const version =
    prCommit && isPkgPrNewCommit(prCommit)
      ? sdkAt(prCommit)
      : await pinPkgPrNewVersion("@iterate-com/petshop-sdk", sdkAt("main"));
  expect(version).toMatch(/@iterate-com\/petshop-sdk@[0-9a-f]{40}$/);
  const pets = await petsFrom({
    slug: "npm-vendor",
    files: {
      "package.json": JSON.stringify({
        main: "worker.ts",
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

test("an npm alias of a platform package: zod3 is zod 3.25.76, its own modules at that version, beside the platform's zod", async () => {
  const project = freshDnsSafeProjectSlug("npm-alias");
  const itx = openItx(await registerProject(project));
  const files = {
    "package.json": JSON.stringify({
      main: "worker.ts",
      dependencies: { zod3: "npm:zod@3.25.76" },
    }),
    // zod 3.25's entry imports its own `zod/v3/…` modules, and `zod3/v4` its own `zod/v4/core`
    "worker.ts": `
      import { z as z3 } from "zod3";
      import { z as z3v4 } from "zod3/v4";
      import { z } from "zod";

      export default {
        fetch: () =>
          Response.json({
            v3: z3.string().parse("three"),
            v4: z3v4.number().parse(4),
            platformZod: z.boolean().parse(true),
            oneZod: z3 === z,
          }),
      };
    `,
  };
  await publishConfigWorker(itx, ["itx", "workers", ["get", { source: files }]]);
  const response = await fetchProjectUrl(projectUrl({ project, routingSlug: "zod", path: "/" }));
  expect(response, response.text).toMatchObject({ status: 200 });
  expect(JSON.parse(response.text)).toMatchObject({
    v3: "three",
    v4: 4,
    platformZod: true,
    oneZod: false,
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

// src/project/publication.ts — ONE PUBLICATION OF THE CONFIG REPO: commit C of `/repos/config`
// becomes the project's code. Its MANIFEST (context/worker-manifest.ts) names each top-level module
// by its identity — the hash of what the loader loads with it as the main module
// (context/worker-loader.ts `moduleIdentityOf`) — and the Durable Object classes it exports, which a
// facet's `className` must name (worker-loader.ts `namedWorkerLoad`). Every top-level module must
// resolve. The PROBE loads them in one worker and admits the commit: the main module's default
// export is an `IterateConfigEntrypoint` that constructs (its constructor and field initializers
// run, never a hook). A commit may drop a class or a whole module: a facet that names it fails its
// next call, saying so. A module other than the main one that throws as it is imported (a script
// beside the worker) keeps its identity in the manifest and exports no class. The POINTER is the rule on `/` that names the
// admitted commit, `itx.config`: every context's birth row delivers to it
// (./context-birth-events.ts) and every facet of the project's config names it (iterate/api
// `FacetSpec`); only the platform writes it (caller.ts `refuseNonPlatformWrites`), so only its manifest
// counts.
// The follower (processor.ts) appends the pointer and `project/worker-updated` in one batch, as the
// platform; a commit that fails here is `project/worker-update-failed`, and the pointer stays where
// it was.

import type { StreamEventInput } from "iterate/stream/processor";
import { z } from "zod";
import { readPackage } from "../context/module-resolution.ts";
import type { WorkerManifest } from "../context/worker-manifest.ts";

/** What a publication reaches, for THIS project (durable-object.ts builds it). */
export type ProjectPublisher = {
  /** `main`'s head of `/repos/config`: what a commit fact asks to publish (anyone may append one),
   *  null while it is unborn. */
  head(): Promise<string | null>;
  /** The files of `/repos/config` at `commitOid`. */
  files(commitOid: string): Promise<Record<string, string>>;
  /** The identity of `mainModule` of `files` (worker-loader.ts `moduleIdentityOf`); throws when it
   *  does not resolve. */
  identityOf(files: Record<string, string>, mainModule: string): Promise<string>;
  /** The answer of `probe()` on `files` loaded as a stateless worker with `mainModule` as its
   *  entry. */
  probe(files: Record<string, string>, mainModule: string): Promise<unknown>;
  /** One batch on `/` as the platform's own facts (`source.platform`): the only writer of
   *  `itx.config`, `project/worker-updated` and `project/worker-update-failed`. */
  appendAsPlatform(...events: StreamEventInput[]): Promise<unknown>;
};

/** The manifest of commit `commitOid` as publication `generation`, admitted by the probe — or a
 *  throw that says why it is not admitted. A platform failure on the way (a read of the repo, a
 *  module lock, the probe's load) throws as itself: the follower meets it again. */
export async function manifestOf(
  commitOid: string,
  generation: number,
  publisher: Pick<ProjectPublisher, "files" | "identityOf" | "probe">,
): Promise<WorkerManifest> {
  const files = await publisher.files(commitOid);
  const { entry } = readPackage(files, "the config repo");
  if (Object.hasOwn(files, PROBE_MODULE))
    throw new Error(`${PROBE_MODULE} is the platform's publication probe: rename that file`);
  const modules = [...new Set([entry, ...topLevelModules(files)])];
  const identities = await Promise.all(
    modules.map(async (module) => [module, await publisher.identityOf(files, module)] as const),
  );
  const probeSource = { ...files, [PROBE_MODULE]: probeModule(entry, modules) };
  const answer = ProbeAnswer.parse(await publisher.probe(probeSource, PROBE_MODULE));
  if (!answer.configEntrypoint)
    throw new Error(
      `${entry}'s default export is not an IterateConfigEntrypoint (iterate/sdk): every context's events are delivered to its deliverEvent`,
    );
  if (answer.constructError)
    throw new Error(
      `${entry}'s default export does not construct: ${answer.constructError} — every delivery and every request constructs it`,
    );
  const manifest = Object.fromEntries(
    identities.map(([module, identity]) => [
      module,
      { identity, classes: answer.classes[module] ?? [] },
    ]),
  );
  return { generation, modules: manifest };
}

/** THE POINTER on `/`, its rows keyed by its generation: `itx.config` names the config repo's
 *  worker at `commitOid` — its modules read at that commit where it is loaded, cached under the
 *  commit — with its manifest. Its producer reads them through `itx.config.modules`, which names the
 *  repo facet at the fixed point: a row on `itx.config…` is the platform's alone
 *  (itx-expression-rewriting.ts `refuseConfigPointerRows`), so no rule anyone appends re-points what
 *  loads under the published identity. */
export function configPointer(commitOid: string, manifest: WorkerManifest): StreamEventInput[] {
  const rule = (match: string, key: string, target: unknown, description: string) => ({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    idempotencyKey: `project/${key}:${manifest.generation}`,
    payload: { match, target, description },
  });
  return [
    rule(
      "itx.config.modules",
      "config-modules",
      [
        "itx",
        "builtins",
        ["cd", "/repos/config"],
        "builtins",
        "facets",
        ["get", "repo"],
        "modules",
      ],
      "the config repo's files at a commit, as the published config's producer reads them",
    ),
    rule(
      "itx.config",
      "config-pointer",
      [
        "itx",
        "builtins",
        "workers",
        [
          "get",
          {
            source: ["itx", "config", ["modules", { commitOid }]],
            cacheKey: commitOid,
            manifest,
          },
        ],
      ],
      `the project's published config: /repos/config at ${commitOid.slice(0, 12)}, publication ${manifest.generation}`,
    ),
  ];
}

/** The probe's own module in the source it loads, beside the author's files: a name the probe
 *  refuses to find among them. */
const PROBE_MODULE = ".iterate-publication-probe.js";

/** What the probe answers: whether the main module's default export is an IterateConfigEntrypoint
 *  and what constructing it threw (null when it constructs), and each module's Durable Object
 *  classes. */
const ProbeAnswer = z.object({
  configEntrypoint: z.boolean(),
  constructError: z.string().nullable(),
  classes: z.record(z.string(), z.array(z.string())),
});

/** The files at the repo's root the manifest names: every module a facet's `mainModule` can be. */
function topLevelModules(files: Record<string, string>): string[] {
  return Object.keys(files)
    .filter((path) => !path.includes("/") && /\.(ts|mts|js|mjs)$/.test(path))
    .filter((path) => !path.endsWith(".d.ts"))
    .sort();
}

/** THE PROBE: a worker entry that imports the main module, constructs its default export with the
 *  probe's own `ctx` and `env` — its constructor and field initializers run, no hook — and imports
 *  every other module guarded (one that throws exports no class), and answers the Durable Object
 *  classes each exports: what a facet's `className` names (`getDurableObjectClass`). */
function probeModule(entry: string, modules: string[]): string {
  const others = modules.filter((module) => module !== entry);
  const guarded = others.map(
    (module) =>
      `  try { classes[${JSON.stringify(module)}] = classesOf(await import(${JSON.stringify(`./${module}`)})); } catch {}`,
  );
  return [
    `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";`,
    `import { IterateConfigEntrypoint } from "iterate/sdk";`,
    `import * as main from ${JSON.stringify(`./${entry}`)};`,
    `const classesOf = (module) => Object.keys(module).filter((key) => typeof module[key] === "function" && module[key].prototype instanceof DurableObject);`,
    `const messageOf = (error) => (error instanceof Error ? error.message : String(error));`,
    `export default class extends WorkerEntrypoint {`,
    `  async probe() {`,
    `    const Entry = main.default;`,
    `    const configEntrypoint = typeof Entry === "function" && Entry.prototype instanceof IterateConfigEntrypoint;`,
    `    let constructError = null;`,
    `    if (configEntrypoint) try { new Entry(this.ctx, this.env); } catch (error) { constructError = messageOf(error); }`,
    `    const classes = { ${JSON.stringify(entry)}: classesOf(main) };`,
    ...guarded,
    `    return { configEntrypoint, constructError, classes };`,
    `  }`,
    `}`,
    ``,
  ].join("\n");
}

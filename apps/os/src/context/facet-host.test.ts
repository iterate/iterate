// context/facet-host.test.ts — A FACET NAMED BY A PUBLISHED WORKER (FacetHost `#materialize`), in
// Node over fakes: the name's resolution is the test's to answer and hold, the loader keys a class by
// the identity its id names, and the host's restarts queue behind one another as
// `blockConcurrencyWhile` queues them. The Workers suite drives the real publication
// (__workers-tests__/named-facets.test.ts).
import { expect, test } from "vitest";
import { unavailableError } from "../unavailable.ts";
import { FacetHost } from "./facet-host.ts";

test("a materialization that resolved an older publication and resumes after a newer one was installed leaves the facet on the newer one: nothing restarts it again", async () => {
  const facets = namedFacets();
  facets.publish(1);
  expect(await facets.boot()).toBe("agents-v1");
  // an older call's resolution is held while a newer publication is installed…
  const older = facets.holdNextResolution();
  const olderBoot = facets.boot();
  facets.publish(2);
  facets.holdRestarts();
  const newerBoot = facets.boot();
  await settle();
  // …and answers the older publication while the newer's restart is under way
  older.answer(1);
  await settle();
  facets.releaseRestarts();
  await Promise.all([olderBoot, newerBoot]);
  expect(facets).toMatchObject({ started: ["agents-v1", "agents-v2"] });
});

test("a live facet outlasts a name it cannot read right now: the platform failed the read, so the facet answers under the identity it runs", async () => {
  const facets = namedFacets();
  facets.publish(1);
  expect(await facets.boot()).toBe("agents-v1");
  facets.failResolutions(unavailableError("overloaded", "the root's rules could not be read"));
  expect(await facets.boot()).toBe("agents-v1");
  expect(facets).toMatchObject({ started: ["agents-v1"] });
});

/** A context's facet host with one facet, `tally`, named by the root's published worker: `publish`
 *  sets the generation the name resolves to (agents.ts's identity `agents-v<generation>`), `boot` is
 *  one call on it answering the identity its class was minted under, and `started` every class the
 *  host minted, in order. */
function namedFacets() {
  const kv = new Map<string, unknown>();
  const started: string[] = [];
  const instances = new Map<string, { boot(): string; listPublicMethods(): string[] }>();
  let generation = 0;
  let holdNext = false;
  let answerHeld = (_generation: number) => {};
  let failure: unknown;
  let restarts = Promise.resolve<unknown>(undefined);
  let releaseRestarts = () => {};
  const named = async () => {
    if (failure) throw failure;
    const at = holdNext
      ? await new Promise<number>((resolve) => {
          holdNext = false;
          answerHeld = resolve;
        })
      : generation;
    return {
      vouched: true,
      invoke: () => Promise.reject(new Error("literal modules — nothing to invoke")),
      spec: {
        source: { "package.json": '{"main":"worker.js"}', "worker.js": "", "agents.ts": "" },
        manifest: {
          generation: at,
          modules: { "agents.ts": { identity: `agents-v${at}`, classes: ["Tally"] } },
        },
      },
    };
  };
  const host = new FacetHost({
    ctx: {
      storage: {
        kv: {
          get: (key: string) => kv.get(key),
          put: (key: string, value: unknown) => void kv.set(key, value),
          delete: (key: string) => kv.delete(key),
          list: () => new Map(),
        },
      },
      facets: {
        get: (name: string, startup: () => { class: { identity: string } }) => {
          let instance = instances.get(name);
          if (!instance) {
            const { identity } = startup().class;
            started.push(identity);
            instance = { boot: () => identity, listPublicMethods: () => ["boot"] };
            instances.set(name, instance);
          }
          return instance;
        },
        abort: (name: string) => void instances.delete(name),
        delete: (name: string) => void instances.delete(name),
      },
      blockConcurrencyWhile: <T>(work: () => Promise<T>) => {
        const run = restarts.then(work);
        restarts = run.catch(() => undefined);
        return run;
      },
      exports: {},
    },
    env: () => ({
      LOADER: {
        get: (id: string) => ({
          getDurableObjectClass: () => ({ identity: /module:(agents-v\d+)/.exec(id)![1] }),
        }),
      },
      ITX_KV: {},
    }),
    deployId: "deploy-1",
    iterateContextName: "prj_unit.iterate/x",
    projectId: "prj_unit",
    path: "/x",
    platformOrigin: () => null,
    itxEntrypoint: () => ({}),
    invoke: () => Promise.reject(new Error("unused")),
    namedWorker: named,
    resolveItxExpression: () => [],
    stream: { coreReducedState: { subscriptions: {} } },
    reconcileAlarm: () => {},
    loadedFacetMaterialized: () => {},
    deliveriesQueuedFor: async () => {},
    cause: () => undefined,
  } as unknown as ConstructorParameters<typeof FacetHost>[0]);
  const tally = host.handle("tally", {
    className: "Tally",
    mainModule: "agents.ts",
    source: ["itx", ["cd", "/"], "config"],
  });
  return {
    started,
    publish: (next: number) => void (generation = next),
    boot: () => host.callFacetAsPlatform(tally, [["boot"]]),
    holdNextResolution: () => {
      holdNext = true;
      return { answer: (at: number) => answerHeld(at) };
    },
    failResolutions: (error: unknown) => void (failure = error),
    holdRestarts: () => {
      restarts = new Promise((resolve) => (releaseRestarts = () => resolve(undefined)));
    },
    releaseRestarts: () => releaseRestarts(),
  };
}

/** Let every promise chain started so far settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

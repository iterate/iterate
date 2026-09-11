import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { base, call, eventually, project, setting, timeout } from "./support.ts";

const processorDeadline = 12_000;

function processor(name: string, body: string) {
  return `import { WorkerEntrypoint } from "cloudflare:workers";
export default class ${name} extends WorkerEntrypoint {
  async processEvent(event) { ${body} }
}`;
}

async function processorEventually(id: string, check: () => Promise<boolean>, description: string) {
  return eventually(
    check,
    description,
    processorDeadline,
    async () => `project=${id}; inspect=${JSON.stringify(await call(id, ["inspect"], []))}`,
  );
}

type EventPage = {
  events: Array<{ id: string; type: string; data: unknown }>;
  throughOffset: number;
};

async function events(id: string, afterOffset = 0): Promise<EventPage> {
  return (await call(id, ["readEvents"], [{ afterOffset, limit: 128 }])) as EventPage;
}

async function hasEvent(id: string, type: string, data?: unknown) {
  return (await events(id)).events.some(
    (event) =>
      event.type === type &&
      (data === undefined || JSON.stringify(event.data) === JSON.stringify(data)),
  );
}

async function processorAttempts(id: string, name: string, error?: string) {
  const inspect = (await call(id, ["inspect"], [])) as {
    processors: Array<{ name: string; attempts: number; error: string | null }>;
  };
  return inspect.processors.some(
    (state) =>
      state.name === name && state.attempts === 3 && (!error || state.error?.includes(error)),
  );
}

async function countEvents(id: string, type: string) {
  let afterOffset = 0;
  let count = 0;
  for (;;) {
    const page = await events(id, afterOffset);
    count += page.events.filter((event) => event.type === type).length;
    if (page.events.length < 128) return count;
    afterOffset = page.throughOffset;
  }
}

const append = (id: string, event: unknown | readonly unknown[]) => call(id, ["append"], [event]);

const set = (id: string, eventId: string, key: string, value: unknown) =>
  append(id, setting(eventId, key, value));

async function installProcessor(
  id: string,
  eventId: string,
  name: string,
  source: string,
  consumes: string[],
  afterOffset = 0,
) {
  return set(id, eventId, `processor/${name}`, {
    source: { modules: { "main.js": source } },
    consumes,
    afterOffset,
  });
}

describe(
  "project core processors",
  { concurrency: false, skip: !base && "set WORKER_BASE_URL to a deployed Worker" },
  () => {
    test(
      "delivers a configured worker once after the source event commits",
      { timeout },
      async () => {
        const id = project();
        const source = processor(
          "Audit",
          'const context = await this.env.ITX.get(); await context.append({ id: "audit/" + event.offset, type: "audit/seen", data: { source: event.id } });',
        );
        await installProcessor(id, "install-audit", "audit", source, ["note"]);
        await append(id, { id: "source-note", type: "note", data: { text: "hello" } });
        await processorEventually(
          id,
          async () => hasEvent(id, "audit/seen", { source: "source-note" }),
          "audit processor did not deliver",
        );
      },
    );

    test("pins a repository revision as processor source", { timeout }, async () => {
      const id = project();
      const source = processor(
        "RepoAudit",
        'const context = await this.env.ITX.get(); await context.append({ id: "repo-audit/" + event.id, type: "repo-audit/seen", data: { id: event.id } });',
      );
      await append(id, {
        id: "repo-source",
        type: "repo.commit",
        data: {
          name: "config",
          files: { "main.js": source },
          parent: null,
          message: "processor source",
        },
      });
      const revision = (await call(id, ["repos", "head"], ["config"])) as { revision: string };
      await set(id, "repo-install", "processor/repo-audit", {
        source: { repo: "config", revision: revision.revision },
        consumes: ["repo-note"],
        afterOffset: 0,
      });
      await append(id, { id: "repo-note", type: "repo-note", data: {} });
      await processorEventually(
        id,
        async () => hasEvent(id, "repo-audit/seen"),
        "repository processor did not deliver",
      );
    });

    test("retries at least once without duplicating an idempotent derived event, then halts", async () => {
      const source = processor(
        "Flaky",
        'const context = await this.env.ITX.get(); await context.append({ id: "once/" + event.id, type: "once", data: { parent: event.id } }); throw new Error("deliberate failure");',
      );
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          const id = project();
          await installProcessor(id, "flaky-install", "flaky", source, ["poison"]);
          await append(id, { id: "poison", type: "poison", data: {} });
          await processorEventually(
            id,
            async () => processorAttempts(id, "flaky", "deliberate failure"),
            "flaky processor did not halt after three deliveries",
          );
          assert.equal(
            (await events(id)).events.filter((event) => event.type === "once").length,
            1,
            `project=${id}`,
          );
        }),
      );
    });

    test(
      "supersedes a terminal configuration and recovers with a new source",
      { timeout },
      async () => {
        const id = project();
        const broken = processor("Broken", 'throw new Error("broken");');
        const fixed = processor(
          "Fixed",
          'const context = await this.env.ITX.get(); await context.append({ id: "fixed/" + event.id, type: "fixed", data: {} });',
        );
        await installProcessor(id, "broken-install", "recover", broken, ["broken-note"]);
        await append(id, { id: "broken-note", type: "broken-note", data: {} });
        await processorEventually(
          id,
          async () => processorAttempts(id, "recover"),
          "broken processor did not halt",
        );
        const head = ((await call(id, ["inspect"], [])) as { head: number }).head;
        await installProcessor(id, "fixed-install", "recover", fixed, ["fixed-note"], head);
        await append(id, { id: "fixed-note", type: "fixed-note", data: {} });
        await processorEventually(
          id,
          async () => hasEvent(id, "fixed"),
          "superseded processor did not recover",
        );
        const state = (await call(id, ["inspect"], [])) as { processors: { name: string }[] };
        assert.deepEqual(
          state.processors.map(({ name }) => name),
          ["recover"],
        );
        await set(id, "remove-recover", "processor/recover", null);
        assert.deepEqual(
          ((await call(id, ["inspect"], [])) as { processors: unknown[] }).processors,
          [],
        );
      },
    );

    test("continues a processor beyond its first 128-event page", { timeout }, async () => {
      const id = project();
      const source = processor(
        "Tail",
        'const context = await this.env.ITX.get(); await context.append({ id: "tail/" + event.id, type: "tail/seen", data: { parent: event.id } });',
      );
      await installProcessor(id, "tail-install", "tail", source, ["tail"]);
      const input = Array.from({ length: 128 }, (_, index) => ({
        id: `tail-${index}`,
        type: "tail",
        data: { index },
      }));
      await append(id, input);
      await processorEventually(
        id,
        async () => (await countEvents(id, "tail/seen")) === 128,
        "tail processor did not finish",
      );
    });
  },
);

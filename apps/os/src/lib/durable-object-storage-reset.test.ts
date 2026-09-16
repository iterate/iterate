import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { expect, test } from "vitest";

test("an object reached by inventory ID can be wiped without changing the deployment", async () => {
  await using runtime = await startRuntime();
  const created = await runtime.request("/create");
  expect(created).toMatchObject({ name: "old-test", kv: "old", sql: "old", memory: "old" });

  await runtime.request(`/kill?id=${created.id}`);
  expect(await runtime.request(`/read?id=${created.id}`)).toMatchObject({ name: "old-test" });
  expect(await runtime.request(`/reset?id=${created.id}`)).toMatchObject({ reset: true });

  expect(await runtime.request("/read")).toMatchObject({
    name: "old-test",
    kv: null,
    sql: null,
    alarm: null,
    memory: "fresh",
  });
  expect(await runtime.request("/health")).toEqual({ version: "unchanged" });
});

test("the reset protocol rejects a changed deployment before touching storage", async () => {
  await using runtime = await startRuntime();
  const created = await runtime.request("/create");
  const response = await runtime.fetch("/operator", {
    method: "POST",
    body: JSON.stringify({ className: "Probe", objectId: created.id, version: "different" }),
  });
  expect(response.status).toBe(409);
  expect(await runtime.request("/read")).toMatchObject({ kv: "old", sql: "old" });
  expect(await runtime.request("/operator")).toEqual({
    protocol: 1,
    version: "unchanged",
    classes: ["Probe"],
  });
});

test("aborting after the wipe prevents an in-flight request from writing its result", async () => {
  await using runtime = await startRuntime();
  const created = await runtime.request("/create");
  const pending = runtime.request(`/pending?id=${created.id}`);
  await runtime.outboundStarted;
  expect(await runtime.request(`/reset?id=${created.id}`)).toMatchObject({ reset: true });
  runtime.finishOutbound();
  expect(await pending).toMatchObject({ aborted: true });
  expect(await runtime.request("/read")).toMatchObject({ kv: null, sql: null, alarm: null });
});

test("wiping a known hosted facet discards its private storage too", async () => {
  await using runtime = await startRuntime();
  const created = await runtime.request("/create");
  expect(await runtime.request("/child-write")).toEqual({ value: "old child" });
  await runtime.request(`/reset?id=${created.id}`);
  expect(await runtime.request("/child-read")).toEqual({ value: null });
});

test("an alarm already waiting on external work loses its pending record and instance", async () => {
  await using runtime = await startRuntime();
  const created = await runtime.request("/create");
  await runtime.request("/start-alarm");
  await runtime.outboundStarted;
  expect(await runtime.request(`/reset?id=${created.id}`)).toMatchObject({ reset: true });
  runtime.finishOutbound();
  expect(await runtime.request("/read")).toMatchObject({ kv: null, sql: null, alarm: null });
});

test("a late caller can recreate an old identity: a reset does not retire it", async () => {
  await using runtime = await startRuntime();
  const created = await runtime.request("/create");
  await runtime.request(`/reset?id=${created.id}`);
  expect(await runtime.request("/create")).toMatchObject({ id: created.id, kv: "old" });
});

async function startRuntime() {
  const directory = await mkdtemp(
    fileURLToPath(new URL("../../node_modules/.cache-storage-reset-", import.meta.url)),
  );
  const scriptPath = join(directory, "worker.mjs");
  await build({
    stdin: {
      contents: `
        import { DurableObject } from 'cloudflare:workers';
        import { StorageResetDurableObject } from './durable-object-storage-reset.ts';
        import { resetStorageRequest } from './reset-storage-request.ts';
        export class Child extends DurableObject {
          write() { this.ctx.storage.kv.put('value', 'old child'); return this.read(); }
          read() { return { value: this.ctx.storage.kv.get('value') || null }; }
        }
        export class Probe extends StorageResetDurableObject {
          memory = 'fresh';
          create() {
            this.memory = 'old';
            this.ctx.storage.kv.put('value', 'old');
            this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS data (value TEXT)');
            this.ctx.storage.sql.exec("INSERT INTO data VALUES ('old')");
            this.ctx.storage.setAlarm(Date.now() + 3600000);
            return this.read();
          }
          async read() {
            const tables = this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='data'").toArray();
            return {
              id: this.ctx.id.toString(), name: this.objectName,
              kv: this.ctx.storage.kv.get('value') || null,
              sql: tables.length ? this.ctx.storage.sql.exec('SELECT value FROM data').one().value : null,
              alarm: await this.ctx.storage.getAlarm(), memory: this.memory,
            };
          }
          async startAlarm() {
            this.ctx.storage.kv.put('pending', true);
            await this.ctx.storage.setAlarm(Date.now());
            return { armed: true };
          }
          async alarm() {
            if (!this.ctx.storage.kv.get('pending')) return;
            await this.pending();
          }
          kill() { this.ctx.abort('test eviction'); }
          async pending() {
            await fetch('http://pending-operation');
            this.ctx.storage.kv.put('value', 'late result');
            return { aborted: false };
          }
          child(write) {
            const child = this.ctx.facets.get('child', () => ({ class: this.ctx.exports.Child }));
            return write ? child.write() : child.read();
          }
          async resetStorage() {
            this.ctx.facets.delete('child');
            await super.resetStorage();
          }
        }
        export default { async fetch(request, env) {
          const url = new URL(request.url);
          if (url.pathname === '/health') return Response.json({ version: 'unchanged' });
          if (url.pathname === '/operator') return resetStorageRequest(request, 'unchanged', { Probe: env.PROBE });
          const id = url.searchParams.get('id');
          const stub = id ? env.PROBE.get(env.PROBE.idFromString(id)) : env.PROBE.getByName('old-test');
          if (url.pathname === '/kill') {
            try { await stub.kill(); } catch (error) { if (!error.durableObjectReset) throw error; }
            return Response.json({ killed: true });
          }
          if (url.pathname === '/reset') {
            return resetStorageRequest(new Request(request.url, {
              method: 'POST', body: JSON.stringify({ className: 'Probe', objectId: id, version: 'unchanged' }),
            }), 'unchanged', { Probe: env.PROBE });
          }
          if (url.pathname === '/pending') {
            try { return Response.json(await stub.pending()); }
            catch (error) { if (!error.durableObjectReset) throw error; return Response.json({ aborted: true }); }
          }
          if (url.pathname.startsWith('/child-')) return Response.json(await stub.child(url.pathname === '/child-write'));
          if (url.pathname === '/start-alarm') return Response.json(await stub.startAlarm());
          return Response.json(await (url.pathname === '/create' ? stub.create() : stub.read()));
        }};
      `,
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    outfile: scriptPath,
    external: ["cloudflare:workers"],
    logLevel: "silent",
  });
  const outboundStarted = Promise.withResolvers<void>();
  const outboundResponse = Promise.withResolvers<Response>();
  const mf = new Miniflare({
    modules: true,
    scriptPath,
    compatibilityDate: "2026-07-01",
    outboundService: async () => {
      outboundStarted.resolve();
      return await outboundResponse.promise;
    },
    durableObjects: { PROBE: { className: "Probe", useSQLite: true } },
  });
  return {
    outboundStarted: outboundStarted.promise,
    finishOutbound() {
      outboundResponse.resolve(new Response("completed"));
    },
    fetch(path: string, init: { method: string; body: string }) {
      return mf.dispatchFetch(`http://storage-reset${path}`, init);
    },
    async request(path: string) {
      const response = await mf.dispatchFetch(`http://storage-reset${path}`);
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()) as any;
    },
    async [Symbol.asyncDispose]() {
      outboundResponse.resolve(new Response("disposed"));
      await mf.dispose();
      await rm(directory, { recursive: true });
    },
  };
}

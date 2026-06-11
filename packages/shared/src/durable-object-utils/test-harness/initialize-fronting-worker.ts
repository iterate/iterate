/// <reference types="@cloudflare/workers-types" />

/**
 * Test-only fronting Worker for the Durable Object mixins.
 *
 * The worker-pool unit tests and deployed E2E tests both use this module as the
 * Worker entrypoint. It gives tests normal HTTP routes while still exercising
 * real Durable Object stubs, RPC methods, fetch wrapping, D1 bindings, and
 * SQLite-backed DO storage. Keeping that wiring in one place makes the unit and
 * deployed tests cover the same composition shape.
 */

import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { listD1ObjectCatalogRecordsByIndex } from "../mixins/with-lifecycle-hooks.ts";
import { withDurableObjectCore } from "../mixins/with-durable-object-core.ts";
import {
  deriveDurableObjectNameFromStructuredName,
  getInitializedDoStub,
  withLifecycleHooks,
} from "../mixins/with-lifecycle-hooks.ts";
import { withKvInspector } from "../mixins/with-kv-inspector.ts";
import { withOuterbase } from "../mixins/with-outerbase.ts";

export type RoomInit = {
  ownerUserId: string;
};

export type RoomInitialState = {
  projectId: string;
  plan: "free" | "pro";
};

const RoomInit = z
  .object({
    ownerUserId: z.string(),
    testName: z.string().optional(),
  })
  .transform(({ ownerUserId }) => ({ ownerUserId }));

const RoomInitialState = z.object({
  projectId: z.string(),
  plan: z.enum(["free", "pro"]),
});

export type SendMessageResult = {
  room: string;
  ownerUserId: string;
  text: string;
};

export type CaughtErrorResult = {
  kind: "error";
  name: string;
  message: string;
};

type Env = {
  ROOMS: DurableObjectNamespace<InitializeTestRoom>;
  INSPECTORS: DurableObjectNamespace<InspectorTestRoom>;
  LISTED_ROOMS: DurableObjectNamespace<ListedRoom>;
  INITIAL_STATE_ROOMS: DurableObjectNamespace<InitialStateTestRoom>;
  DO_CATALOG: D1Database;
};

const DurableObjectCore = withDurableObjectCore(DurableObject);

const RoomBase = withLifecycleHooks({
  d1ObjectCatalog: "none",
  nameSchema: RoomInit,
})(DurableObjectCore);
const InitialStateRoomBase = withLifecycleHooks({
  d1ObjectCatalog: "none",
  initialStateSchema: RoomInitialState,
})(DurableObjectCore);

export class InitialStateTestRoom extends InitialStateRoomBase<Env> {
  getInitialStateForTest(): RoomInitialState {
    return this.initialState;
  }

  getNameForTest(): string {
    return this.name;
  }

  async tryInitialize(input: { name: string; initialState?: RoomInitialState }) {
    try {
      return await this.initialize(input);
    } catch (error) {
      return serializeError(error);
    }
  }
}

export class InitializeTestRoom extends RoomBase<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.registerOnFirstInitialize((params) => {
      const runs = this.ctx.storage.kv.get<number>("test.firstInitializeHookRuns") ?? 0;
      this.ctx.storage.kv.put("test.firstInitializeHookRuns", runs + 1);
      this.ctx.storage.kv.put("test.firstInitializeHookOwnerUserId", params.ownerUserId);
    });

    this.registerOnInstanceWake(async () => {
      const runs = this.ctx.storage.kv.get<number>("test.instanceWakeHookRuns") ?? 0;
      this.ctx.storage.kv.put("test.instanceWakeHookRuns", runs + 1);
      this.ctx.storage.kv.put("test.instanceWakeHookStarted", true);

      // Keep this asynchronous so tests prove initialize()/ensureStarted()
      // wait for hook completion rather than fire-and-forget constructor work.
      await Promise.resolve();

      if (this.name.includes("hook-fails-once")) {
        const alreadyFailed =
          this.ctx.storage.kv.get<boolean>("test.instanceWakeHookFailedOnce") ?? false;

        if (!alreadyFailed) {
          this.ctx.storage.kv.put("test.instanceWakeHookFailedOnce", true);
          throw new Error("instance wake hook failed once");
        }
      }

      if (this.name.includes("hook-throws-undefined")) {
        // JavaScript allows throwing any value, including `undefined`.
        // The lifecycle implementation must treat that as a real startup
        // failure rather than confusing it with the "no error captured" state.
        throw undefined;
      }

      this.ctx.storage.kv.put("test.instanceWakeHookFinished", true);
    });
  }

  sendMessage(text: string): SendMessageResult {
    const { ownerUserId } = this.structuredName;

    return {
      room: this.name,
      ownerUserId,
      text,
    };
  }

  getStructuredName(): RoomInit {
    return this.assertInitialized();
  }

  async ensureReady(): Promise<RoomInit> {
    return await this.ensureStarted();
  }

  getLifecycleHookState(): {
    firstInitializeRuns: number;
    firstInitializeOwnerUserId: string | null;
    instanceWakeRuns: number;
    instanceWakeStarted: boolean;
    instanceWakeFinished: boolean;
    instanceWakeFailedOnce: boolean;
  } {
    return {
      firstInitializeRuns: this.ctx.storage.kv.get<number>("test.firstInitializeHookRuns") ?? 0,
      firstInitializeOwnerUserId:
        this.ctx.storage.kv.get<string>("test.firstInitializeHookOwnerUserId") ?? null,
      instanceWakeRuns: this.ctx.storage.kv.get<number>("test.instanceWakeHookRuns") ?? 0,
      instanceWakeStarted:
        this.ctx.storage.kv.get<boolean>("test.instanceWakeHookStarted") ?? false,
      instanceWakeFinished:
        this.ctx.storage.kv.get<boolean>("test.instanceWakeHookFinished") ?? false,
      instanceWakeFailedOnce:
        this.ctx.storage.kv.get<boolean>("test.instanceWakeHookFailedOnce") ?? false,
    };
  }

  async initializeTwiceConcurrently(params: RoomInit): Promise<{
    results: [RoomInit, RoomInit];
    hookRuns: number;
  }> {
    const input = this.getInitializeInput(params);
    const results = (await Promise.all([this.initialize(input), this.initialize(input)])) as [
      RoomInit,
      RoomInit,
    ];

    return {
      results,
      hookRuns: this.getLifecycleHookState().instanceWakeRuns,
    };
  }

  trySendMessage(text: string): SendMessageResult | CaughtErrorResult {
    try {
      return this.sendMessage(text);
    } catch (error) {
      return serializeError(error);
    }
  }

  async tryInitialize(params: RoomInit): Promise<RoomInit | CaughtErrorResult> {
    try {
      return await this.initialize(this.getInitializeInput(params));
    } catch (error) {
      return serializeError(error);
    }
  }

  async tryInitializeName(input: { name: string }): Promise<RoomInit | CaughtErrorResult> {
    try {
      return await this.initialize(input);
    } catch (error) {
      return serializeError(error);
    }
  }

  async tryEnsureReady(): Promise<RoomInit | CaughtErrorResult> {
    try {
      return await this.ensureReady();
    } catch (error) {
      return serializeError(error);
    }
  }

  private getInitializeInput(params: RoomInit): { name: string } {
    const runtimeName = this.getDurableObjectName();
    if (runtimeName !== undefined) {
      return { name: runtimeName };
    }

    return {
      name: deriveDurableObjectNameFromStructuredName({ structuredName: params }),
    };
  }
}

const ListedRoomBase = withLifecycleHooks<RoomInit, undefined, Env>({
  d1ObjectCatalog: {
    className: "ListedRoom",
    getDatabase(env) {
      return env.DO_CATALOG;
    },
    indexes: {
      ownerUserId(params) {
        return params.ownerUserId;
      },
    },
  },
  nameSchema: RoomInit,
})(DurableObjectCore);

export class ListedRoom extends ListedRoomBase<Env> {
  getStructuredName(): RoomInit {
    return this.assertInitialized();
  }
}

const InspectorBase = withKvInspector({
  unsafe: "I_UNDERSTAND_THIS_EXPOSES_KV",
})(
  withOuterbase({
    unsafe: "I_UNDERSTAND_THIS_EXPOSES_SQL",
  })(DurableObjectCore),
);

export class InspectorTestRoom extends InspectorBase<Env> {
  seedKv(key: string, value: unknown) {
    this.ctx.storage.kv.put(key, value);
  }

  seedSql() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, text TEXT)",
    );
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO messages (id, text) VALUES (?, ?)",
      "msg_1",
      "hello",
    );
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const inspectorMatch = url.pathname.match(/^\/inspectors\/([^/]+)(\/.*)$/);

    if (inspectorMatch !== null) {
      const [, rawName, inspectorPath] = inspectorMatch;
      const stub = env.INSPECTORS.getByName(decodeURIComponent(rawName));

      if (request.method === "POST" && inspectorPath === "/seed-kv") {
        const body = await request.json<{ key?: string; value?: unknown }>();
        await stub.seedKv(requireString(body.key, "key"), body.value);

        return json({ ok: true });
      }

      if (request.method === "POST" && inspectorPath === "/seed-sql") {
        await stub.seedSql();

        return json({ ok: true });
      }

      // The fronting worker keeps the public test URL stable while the DO still
      // exercises the fetch wrapper exactly as it runs in production.
      const proxiedUrl = new URL(inspectorPath, "https://durable-object.local");
      return await stub.fetch(new Request(proxiedUrl, request));
    }

    const listedOwnerIndexMatch = url.pathname.match(/^\/listed-rooms\/by-owner-user-id\/([^/]+)$/);

    if (listedOwnerIndexMatch !== null) {
      const [, rawOwnerUserId] = listedOwnerIndexMatch;

      return json(
        await listD1ObjectCatalogRecordsByIndex<RoomInit>(env.DO_CATALOG, {
          className: "ListedRoom",
          indexName: "ownerUserId",
          indexValue: decodeURIComponent(rawOwnerUserId),
        }),
      );
    }

    const listedMatch = url.pathname.match(/^\/listed-rooms\/([^/]+)\/([^/]+)$/);

    if (listedMatch !== null) {
      const [, rawName, action] = listedMatch;
      const name = decodeURIComponent(rawName);

      if (request.method === "POST" && action === "initialize") {
        const stub = env.LISTED_ROOMS.getByName(name);
        await stub.initialize({ name });

        return json(await stub.getStructuredName());
      }

      if (request.method === "GET" && action === "catalog") {
        const stub = env.LISTED_ROOMS.getByName(name);

        return json(await stub.getD1ObjectCatalogRecord());
      }

      return json({ error: "Not found" }, { status: 404 });
    }

    const match = url.pathname.match(/^\/rooms\/([^/]+)\/([^/]+)$/);

    if (match === null) {
      return json({ error: "Not found" }, { status: 404 });
    }

    const [, rawName, action] = match;
    const name = decodeURIComponent(rawName);

    try {
      if (request.method === "POST" && action === "initialize") {
        const body = await request.json<Partial<RoomInit>>();
        const stub = await getInitializedDoStub({
          allowCreate: true,
          namespace: env.ROOMS,
          name: {
            ownerUserId: requireString(body.ownerUserId, "ownerUserId"),
          },
        });

        return json(await stub.getStructuredName());
      }

      if (request.method === "POST" && action === "message") {
        const body = await request.json<{ text?: string }>();
        const stub = env.ROOMS.getByName(name);
        const result = await stub.trySendMessage(requireString(body.text, "text"));

        if (
          typeof result === "object" &&
          result !== null &&
          "kind" in result &&
          result.kind === "error"
        ) {
          return json(
            {
              error: result.name,
              message: result.message,
            },
            { status: 500 },
          );
        }

        return json(result);
      }

      if (request.method === "GET" && action === "init") {
        const stub = env.ROOMS.getByName(name);

        return json(await stub.getStructuredName());
      }

      return json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      return json(
        {
          error: error instanceof Error ? error.name : "UnknownError",
          message: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<Env>;

function requireString(value: string | undefined, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldName} is required`);
  }

  return value;
}

function json(body: unknown, init?: ResponseInit): Response {
  // `Response.json(undefined)` throws because `undefined` is not valid JSON.
  // Normalize it here so future test routes return explicit JSON `null`
  // instead of a Worker exception.
  return Response.json(body ?? null, init);
}

function serializeError(error: unknown): CaughtErrorResult {
  return {
    kind: "error",
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  };
}

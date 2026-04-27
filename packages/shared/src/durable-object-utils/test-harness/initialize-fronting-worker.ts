/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import { withExternalListing } from "../mixins/external-listing.ts";
import { getInitializedDoStub, withInitialize } from "../mixins/initialize.ts";
import { withKvInspector } from "../mixins/kv-inspector.ts";
import { withOuterbase } from "../mixins/outerbase.ts";

export type RoomInit = {
  name: string;
  ownerUserId: string;
};

export type SendMessageResult = {
  room: string;
  ownerUserId: string;
  text: string;
};

export type CaughtErrorResult = {
  name: string;
  message: string;
};

type Env = {
  ROOMS: DurableObjectNamespace<InitializeTestRoom>;
  INSPECTORS: DurableObjectNamespace<InspectorTestRoom>;
  LISTED_ROOMS: DurableObjectNamespace<ListedRoom>;
  DO_LISTINGS: D1Database;
};

const RoomBase = withInitialize<RoomInit>()(DurableObject);

export class InitializeTestRoom extends RoomBase<Env> {
  sendMessage(text: string): SendMessageResult {
    const { name, ownerUserId } = this.initParams;

    return {
      room: name,
      ownerUserId,
      text,
    };
  }

  getInitParams(): RoomInit {
    return this.assertInitialized();
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
      return await this.initialize(params);
    } catch (error) {
      return serializeError(error);
    }
  }
}

const ListedRoomBase = withExternalListing<RoomInit, Env>({
  className: "ListedRoom",
  getDatabase(env) {
    return env.DO_LISTINGS;
  },
})(withInitialize<RoomInit>()(DurableObject));

export class ListedRoom extends ListedRoomBase<Env> {
  getInitParams(): RoomInit {
    return this.assertInitialized();
  }
}

class InspectorRoot extends DurableObject<Env> {}

const InspectorBase = withKvInspector({
  unsafe: "I_UNDERSTAND_THIS_EXPOSES_KV",
})(
  withOuterbase({
    unsafe: "I_UNDERSTAND_THIS_EXPOSES_SQL",
  })(InspectorRoot),
);

export class InspectorTestRoom extends InspectorBase {
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

    const listedMatch = url.pathname.match(/^\/listed-rooms\/([^/]+)\/([^/]+)$/);

    if (listedMatch !== null) {
      const [, rawName, action] = listedMatch;
      const name = decodeURIComponent(rawName);

      if (request.method === "POST" && action === "initialize") {
        const body = await request.json<Partial<RoomInit>>();
        const stub = await getInitializedDoStub({
          namespace: env.LISTED_ROOMS,
          name,
          initParams: {
            ownerUserId: requireString(body.ownerUserId, "ownerUserId"),
          },
        });

        return json(await stub.getInitParams());
      }

      if (request.method === "GET" && action === "listing") {
        const stub = env.LISTED_ROOMS.getByName(name);

        // The external listing write is best-effort and runs through waitUntil,
        // so callers can observe the "not listed yet" state. JSON has no
        // representation for `undefined`, and `Response.json(undefined)` throws
        // at runtime; use `null` as the explicit wire value for "no listing".
        return json((await stub.getExternalListing()) ?? null);
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
          namespace: env.ROOMS,
          name,
          initParams: {
            ownerUserId: requireString(body.ownerUserId, "ownerUserId"),
          },
        });

        return json(await stub.getInitParams());
      }

      if (request.method === "POST" && action === "message") {
        const body = await request.json<{ text?: string }>();
        const stub = env.ROOMS.getByName(name);
        const result = await stub.trySendMessage(requireString(body.text, "text"));

        if (isCaughtErrorResult(result)) {
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

        return json(await stub.getInitParams());
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
  return Response.json(body, init);
}

function serializeError(error: unknown): CaughtErrorResult {
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  };
}

function isCaughtErrorResult(
  value: SendMessageResult | CaughtErrorResult,
): value is CaughtErrorResult {
  return "name" in value && "message" in value;
}

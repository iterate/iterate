import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { PublicRouteTestRoom } from "../test-harness/initialize-fronting-worker.ts";
import { routeDurableObjectRequest } from "./with-public-fetch-route.ts";

const testEnv = env as {
  PUBLIC_ROUTE_ROOMS: DurableObjectNamespace<PublicRouteTestRoom>;
};

describe("withPublicFetchRoute", () => {
  it("initializes and proxies requests by init params", async () => {
    const roomName = `public-route-${crypto.randomUUID()}`;
    const encodedInitParams = encodeURIComponent(
      JSON.stringify({
        name: roomName,
        ownerUserId: "user-init",
      }),
    );

    const response = await SELF.fetch(
      `https://example.com/durable-objects/public-route-rooms/by-init-params/${encodedInitParams}/messages/hello?via=init`,
      {
        method: "POST",
        body: "payload-init",
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      durableObjectName: roomName,
      ownerUserId: "user-init",
      pathname: "/messages/hello",
      search: "?via=init",
      method: "POST",
      bodyText: "payload-init",
    });

    await expect(
      testEnv.PUBLIC_ROUTE_ROOMS.getByName(roomName).getInitParamsForTest(),
    ).resolves.toEqual({
      name: roomName,
      ownerUserId: "user-init",
    });
  });

  it("builds default and explicit public paths from the instance helper", async () => {
    const roomName = `public-paths-${crypto.randomUUID()}`;
    const room = testEnv.PUBLIC_ROUTE_ROOMS.getByName(roomName);

    await room.initialize({
      name: roomName,
      ownerUserId: "user-paths",
    });

    const id = await room.getIdStringForTest();
    const paths = await room.getPublicPathsForTest();

    expect(paths.defaultPath).toBe(paths.byInitParamsPath);
    expect(paths.byNamePath).toBe(
      `/durable-objects/public-route-rooms/by-name/${encodeURIComponent(roomName)}`,
    );
    expect(paths.byIdPath).toBe(
      `/durable-objects/public-route-rooms/by-id/${encodeURIComponent(id)}`,
    );

    const defaultResponse = await SELF.fetch(
      `https://example.com${paths.defaultPath}/state?mode=default`,
    );
    expect(defaultResponse.status).toBe(200);
    expect(await defaultResponse.json()).toMatchObject({
      durableObjectName: roomName,
      ownerUserId: "user-paths",
      pathname: "/state",
      search: "?mode=default",
      method: "GET",
    });
  });

  it("routes the same object by name and by id", async () => {
    const roomName = `public-route-shared-${crypto.randomUUID()}`;
    const room = testEnv.PUBLIC_ROUTE_ROOMS.getByName(roomName);

    await room.initialize({
      name: roomName,
      ownerUserId: "user-shared",
    });

    const id = await room.getIdStringForTest();

    const byNameResponse = await SELF.fetch(
      `https://example.com/durable-objects/public-route-rooms/by-name/${encodeURIComponent(roomName)}/by-name`,
    );
    expect(byNameResponse.status).toBe(200);
    expect(await byNameResponse.json()).toMatchObject({
      durableObjectName: roomName,
      ownerUserId: "user-shared",
      pathname: "/by-name",
    });

    const byIdResponse = await SELF.fetch(
      `https://example.com/durable-objects/public-route-rooms/by-id/${encodeURIComponent(id)}/by-id`,
    );
    expect(byIdResponse.status).toBe(200);
    expect(await byIdResponse.json()).toMatchObject({
      durableObjectName: roomName,
      ownerUserId: "user-shared",
      pathname: "/by-id",
    });
  });
});

describe("routeDurableObjectRequest", () => {
  it("returns undefined when the request does not target the durable object public prefix", async () => {
    await expect(
      routeDurableObjectRequest(new Request("https://example.com/not-durable-objects"), []),
    ).resolves.toBeUndefined();
  });

  it("returns 404 for an unknown namespace slug", async () => {
    const response = await routeDurableObjectRequest(
      new Request("https://example.com/durable-objects/missing/by-name/example"),
      [],
    );

    expect(response?.status).toBe(404);
    await expect(response?.json()).resolves.toEqual({
      error: "Not found",
    });
  });

  it("returns 400 for malformed init params payloads", async () => {
    const getByName = vi.fn();
    const get = vi.fn();
    const idFromString = vi.fn();
    const registrations = [
      {
        namespaceSlug: "rooms",
        namespace: {
          getByName,
          get,
          idFromString,
        } as unknown as DurableObjectNamespace<PublicRouteTestRoom>,
      },
    ];

    const malformedJson = await routeDurableObjectRequest(
      new Request("https://example.com/durable-objects/rooms/by-init-params/%7Bbad-json%7D"),
      registrations,
    );
    expect(malformedJson?.status).toBe(400);
    await expect(malformedJson?.json()).resolves.toEqual({
      error: "Invalid init params JSON.",
    });

    const primitiveJson = await routeDurableObjectRequest(
      new Request("https://example.com/durable-objects/rooms/by-init-params/123"),
      registrations,
    );
    expect(primitiveJson?.status).toBe(400);
    await expect(primitiveJson?.json()).resolves.toEqual({
      error: "Init params must decode to a plain object.",
    });

    expect(getByName).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(idFromString).not.toHaveBeenCalled();
  });
});

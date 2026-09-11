import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { withTunnel } from "../../../os/e2e/test-support/tunnel.ts";
import { MobileFetchCapabilities } from "./mobile-fetch.ts";

test("phone fetch preserves binary request and response bodies and HTTP failure status", async () => {
  await using server = await withTunnel(async (request) => {
    expect(request.method).toBe("POST");
    expect(Object.fromEntries(request.headers)).toMatchObject({
      "x-phone-proof": "from-script",
      "x-iterate-client": "mobile",
    });
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(new Uint8Array([0, 255, 42]));
    return new Response(new Uint8Array([42, 255, 0]), {
      status: 422,
      headers: { "content-type": "application/octet-stream", "x-upstream": "phone" },
    });
  });
  const phone = new MobileFetchCapabilities(fetch, () => true);
  const response = await phone.doFetch({
    url: server.url,
    method: "POST",
    headers: [["x-phone-proof", "from-script"]],
    body: new Uint8Array([0, 255, 42]),
  });
  expect(response).toMatchObject({ status: 422, body: new Uint8Array([42, 255, 0]) });
  expect(new Headers(response.headers).get("x-upstream")).toBe("phone");
});

test("native redirects stay on the phone and decoded bytes lose compression headers", async () => {
  const paths: string[] = [];
  await using server = await withTunnel((request) => {
    const url = new URL(request.url);
    paths.push(url.pathname);
    if (url.pathname === "/")
      return new Response(null, { status: 302, headers: { location: "/body" } });
    const body = gzipSync("phone response");
    return new Response(body, {
      headers: { "content-encoding": "gzip", "content-length": String(body.byteLength) },
    });
  });
  const response = await new MobileFetchCapabilities(fetch, () => true).doFetch({
    url: server.url,
    method: "GET",
    headers: [],
    body: null,
  });
  expect(paths).toEqual(["/", "/body"]);
  expect(new TextDecoder().decode(response.body!)).toBe("phone response");
  expect(new Headers(response.headers).has("content-encoding")).toBe(false);
  expect(new Headers(response.headers).has("content-length")).toBe(false);
});

test("background phones reject before making a network request", async () => {
  let requests = 0;
  await using server = await withTunnel(() => {
    requests++;
    return new Response("unexpected");
  });
  await expect(
    new MobileFetchCapabilities(fetch, () => false).doFetch({
      url: server.url,
      method: "GET",
      headers: [],
      body: null,
    }),
  ).rejects.toThrow("background");
  expect(requests).toBe(0);
});

test("bodyless responses and oversized responses retain explicit outcomes", async () => {
  await using server = await withTunnel((request) =>
    new URL(request.url).pathname === "/large"
      ? new Response(new Uint8Array(8 * 1024 * 1024 + 1))
      : new Response(null, { status: 204 }),
  );
  const phone = new MobileFetchCapabilities(fetch, () => true);
  expect(
    await phone.doFetch({ url: server.url, method: "GET", headers: [], body: null }),
  ).toMatchObject({ status: 204, body: null });
  await expect(
    phone.doFetch({ url: server.url + "/large", method: "GET", headers: [], body: null }),
  ).rejects.toThrow("exceeds 8 MiB");
});

test("HEAD metadata can describe a large resource without downloading it", async () => {
  await using server = await withTunnel(
    () =>
      new Response(null, {
        headers: { "content-length": String(16 * 1024 * 1024) },
      }),
  );
  expect(
    await new MobileFetchCapabilities(fetch, () => true).doFetch({
      url: server.url,
      method: "HEAD",
      headers: [],
      body: null,
    }),
  ).toMatchObject({ status: 200, body: null });
});

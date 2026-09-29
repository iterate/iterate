import { expect, test, vi } from "vitest";
import { XClient, XHttpError } from "./client.ts";

test("X requests use a pinned secret placeholder and preserve pagination", async () => {
  const requests: Request[] = [];
  const client = new XClient(async (request) => {
    requests.push(request);
    return Response.json({ data: [], meta: { next_token: "next-page" } });
  }, "mine");
  expect(await client.bookmarks("123", "page-1")).toMatchObject({
    data: [],
    meta: { next_token: "next-page" },
  });
  const request = requests[0]!;
  expect({
    origin: new URL(request.url).origin,
    token: request.headers.get("authorization"),
    page: new URL(request.url).searchParams.get("pagination_token"),
    redirect: request.redirect,
  }).toMatchObject({
    origin: "https://api.x.com",
    token: 'Bearer getSecret("/secrets/x-mine", { field: "accessToken" })',
    page: "page-1",
    redirect: "manual",
  });
});

test("an ambiguous X write is attempted once without echoing its response body", async () => {
  const fetcher = vi.fn(async () => new Response("private provider response", { status: 503 }));
  await expect(new XClient(fetcher, "bot").reply("123", "Hello")).rejects.toThrow("answered 503");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("malformed account responses never become identity evidence", async () => {
  const client = new XClient(
    async () => Response.json({ data: { id: "@jonas", username: "jonas" } }),
    "mine",
  );
  await expect(client.me()).rejects.toThrow();
});

test("mentions preserve both the checkpoint and the pagination cursor", async () => {
  const requests: Request[] = [];
  const client = new XClient(async (request) => {
    requests.push(request);
    return Response.json({ data: [], meta: { next_token: "page-3" } });
  }, "mine");
  expect(await client.mentions("123", { sinceId: "456", paginationToken: "page-2" })).toMatchObject(
    { meta: { next_token: "page-3" } },
  );
  expect(Object.fromEntries(new URL(requests[0]!.url).searchParams)).toMatchObject({
    since_id: "456",
    pagination_token: "page-2",
  });
});

test("a rejected write carries its HTTP status without leaking the provider body", async () => {
  const client = new XClient(
    async () => new Response("private provider response", { status: 429 }),
    "bot",
  );
  await expect(client.reply("123", "Hello")).rejects.toMatchObject({
    status: 429,
    message: "X POST /2/tweets answered 429",
  });
  await expect(client.reply("123", "Hello")).rejects.toBeInstanceOf(XHttpError);
});

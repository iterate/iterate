// library/openapi.test.ts — the OpenAPI connection against a fake service behind a fake `itx.fetch`:
// how one input object becomes path, query, header and body, and where the base URL comes from.
import { describe, expect, test } from "vitest";
import { connectToOpenApi, type OpenApiDocument } from "./openapi.ts";
import type { LibraryItx } from "./index.ts";

const SPEC: OpenApiDocument = {
  openapi: "3.0.0",
  servers: [{ url: "https://api.example/v1" }],
  paths: {
    "/pets/{id}": {
      parameters: [{ name: "id", in: "path", required: true }],
      get: { operationId: "getPet", summary: "one pet" },
      delete: { operationId: "deletePet" },
    },
    "/pets": {
      get: {
        operationId: "listPets",
        parameters: [
          { name: "limit", in: "query", required: true },
          { name: "tag", in: "query" },
        ],
      },
      post: { operationId: "createPet", requestBody: { content: { "application/json": {} } } },
    },
    "/me": { get: { operationId: "me", parameters: [{ name: "x-user", in: "header" }] } },
    "/raw": { put: { operationId: "putRaw", requestBody: {} } },
    "/text": { get: { operationId: "getText" } },
    "/call": { get: { operationId: "call" } }, // reserved: reachable through call('call') only
  },
};

function fakeItx(answer: (request: Request) => Response = () => json({ ok: true })) {
  const requests: Request[] = [];
  const itx = {
    fetch: async (request: Request) => {
      requests.push(request);
      return answer(request);
    },
  } as unknown as LibraryItx;
  return { itx, requests };
}
const json = (value: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(value), { ...init, headers: { "content-type": "application/json" } });

describe("connectToOpenApi", () => {
  const rows: Array<{
    op: string;
    input?: Record<string, unknown>;
    method: string;
    url: string;
    body?: unknown;
    header?: [string, string];
    throws?: RegExp;
  }> = [
    { op: "getPet", input: { id: "a/b" }, method: "GET", url: "https://api.example/v1/pets/a%2Fb" },
    { op: "deletePet", input: { id: 7 }, method: "DELETE", url: "https://api.example/v1/pets/7" },
    {
      op: "listPets",
      input: { limit: 2, tag: "cat" },
      method: "GET",
      url: "https://api.example/v1/pets?limit=2&tag=cat",
    },
    {
      op: "listPets",
      input: { limit: 2 },
      method: "GET",
      url: "https://api.example/v1/pets?limit=2",
    },
    {
      op: "createPet",
      input: { name: "rex", age: 3 },
      method: "POST",
      url: "https://api.example/v1/pets",
      body: { name: "rex", age: 3 },
    },
    {
      op: "putRaw",
      input: { body: [1, 2] },
      method: "PUT",
      url: "https://api.example/v1/raw",
      body: [1, 2],
    }, // `{ body }` alone is the body verbatim
    {
      op: "me",
      input: { "x-user": "u1" },
      method: "GET",
      url: "https://api.example/v1/me",
      header: ["x-user", "u1"],
    },
    { op: "getPet", input: {}, method: "GET", url: "", throws: /getPet needs "id"/ },
    {
      op: "listPets",
      input: {},
      method: "GET",
      url: "",
      throws: /listPets needs query parameter "limit"/,
    },
    {
      op: "getText",
      input: { junk: 1 },
      method: "GET",
      url: "",
      throws: /getText has no request body and got unknown input key "junk"/,
    },
    { op: "nope", method: "GET", url: "", throws: /no operation "nope"/ },
  ];
  for (const row of rows)
    test(`${row.op}(${JSON.stringify(row.input ?? {})}) → ${row.throws ?? `${row.method} ${row.url}`}`, async () => {
      const { itx, requests } = fakeItx();
      const conn = await connectToOpenApi(itx, SPEC, { headers: { authorization: "Bearer t" } });
      if (row.throws) {
        await expect(conn.call(row.op, row.input)).rejects.toThrow(row.throws);
        return;
      }
      expect(await conn.call(row.op, row.input)).toEqual({ ok: true });
      const [request] = requests;
      expect(request.method).toBe(row.method);
      expect(request.url).toBe(row.url);
      expect(request.headers.get("authorization")).toBe("Bearer t");
      if (row.body !== undefined) {
        expect(JSON.parse(await request.text())).toEqual(row.body);
        expect(request.headers.get("content-type")).toBe("application/json");
      } else expect(request.body).toBeNull();
      if (row.header) expect(request.headers.get(row.header[0])).toBe(row.header[1]);
    });

  test("operations become methods; a reserved operationId stays reachable through call()", async () => {
    const { itx, requests } = fakeItx();
    const conn = await connectToOpenApi(itx, SPEC);
    expect(conn.operations().map((o) => o.operationId)).toEqual([
      "getPet",
      "deletePet",
      "listPets",
      "createPet",
      "me",
      "putRaw",
      "getText",
      "call",
    ]);
    expect(await (conn as any).getPet({ id: 1 })).toEqual({ ok: true });
    expect(await conn.call("call")).toEqual({ ok: true });
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual(["/v1/pets/1", "/v1/call"]);
  });

  test("a text answer is text; a non-2xx answer throws with the status and a snippet", async () => {
    const { itx } = fakeItx((request) =>
      request.url.endsWith("/text")
        ? new Response("plain", { headers: { "content-type": "text/plain" } })
        : new Response("gone", { status: 410 }),
    );
    const conn = await connectToOpenApi(itx, SPEC);
    expect(await conn.call("getText")).toBe("plain");
    await expect(conn.call("getPet", { id: 1 })).rejects.toThrow(
      /GET \/v1\/pets\/1 \(getPet\) returned 410: gone/,
    );
  });

  test("from a URL: the document is fetched (auth headers only on the API's host), and a document without servers is addressed under the spec URL, QUERY KEPT (the fetch lane)", async () => {
    const lane = "https://worker.example/expression/openapi.json?context=prj_x&itx=itx.site";
    const { itx, requests } = fakeItx((request) =>
      request.url === lane
        ? json({ ...SPEC, servers: [] })
        : json({ pet: new URL(request.url).pathname }),
    );
    const conn = await connectToOpenApi(itx, lane, { headers: { authorization: "Bearer t" } });
    expect(requests[0].headers.get("authorization")).toBe("Bearer t");
    expect(await conn.call("getPet", { id: 5 })).toEqual({ pet: "/expression/pets/5" });
    expect(requests[1].url).toBe(
      "https://worker.example/expression/pets/5?context=prj_x&itx=itx.site",
    );
    // the spec on another host than the API (baseUrl names the API): the auth header stays home
    const other = fakeItx((request) =>
      request.url.includes("spec.example") ? json(SPEC) : json({}),
    );
    const conn2 = await connectToOpenApi(other.itx, "https://spec.example/openapi.json", {
      baseUrl: "https://api.example/v1",
      headers: { authorization: "Bearer t" },
    });
    expect(other.requests[0].headers.get("authorization")).toBeNull();
    await conn2.call("getPet", { id: 1 });
    expect(other.requests[1].headers.get("authorization")).toBe("Bearer t");
  });

  test("baseUrl overrides the document's server", async () => {
    const { itx, requests } = fakeItx();
    const conn = await connectToOpenApi(itx, SPEC, { baseUrl: "https://staging.example/api/" });
    await conn.call("getPet", { id: 1 });
    expect(requests[0].url).toBe("https://staging.example/api/pets/1");
  });

  test("not an OpenAPI document → refused at connect", async () => {
    await expect(connectToOpenApi(fakeItx().itx, { nope: true } as any)).rejects.toThrow(
      /not an OpenAPI 3 document/,
    );
  });
});

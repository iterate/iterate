import { describe, expect, test } from "vitest";
import { HttpResponse, http, useMockHttpServer } from "@iterate-com/mock-http-proxy";
import { executeOpenApiToolFunction } from "./openapi-bridge-core.ts";

describe("OpenAPI bridge core", () => {
  test("executes an operation against a mocked OpenAPI server", async () => {
    await using server = await useMockHttpServer({ transformRequest: false });
    server.use(
      http.get(`${server.url}/openapi.json`, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer openapi-token");
        return HttpResponse.json({
          openapi: "3.1.0",
          info: { title: "Mock Petstore", version: "1.0.0" },
          paths: {
            "/pets/{petId}": {
              get: {
                operationId: "getPet",
                summary: "Get pet",
                parameters: [
                  { in: "path", name: "petId", required: true, schema: { type: "string" } },
                  { in: "query", name: "include", schema: { type: "string" } },
                ],
              },
            },
          },
        });
      }),
      http.get(`${server.url}/pets/:petId`, ({ params, request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer openapi-token");
        const url = new URL(request.url);
        return HttpResponse.json({
          include: url.searchParams.get("include"),
          name: "Ada",
          petId: params.petId,
        });
      }),
    );

    await expect(
      executeOpenApiToolFunction({
        args: [{ include: "owner", petId: "pet-123" }],
        functionPath: ["getPet"],
        providerProps: {
          baseUrl: server.url,
          headers: { authorization: "Bearer openapi-token" },
          specUrl: `${server.url}/openapi.json`,
        },
      }),
    ).resolves.toEqual({
      include: "owner",
      name: "Ada",
      petId: "pet-123",
    });
  });

  test("lists mocked OpenAPI operations as a normal codemode function", async () => {
    await using server = await useMockHttpServer({ transformRequest: false });
    server.use(
      http.get(`${server.url}/openapi.json`, () =>
        HttpResponse.json({
          openapi: "3.1.0",
          info: { title: "Mock Petstore", version: "1.0.0" },
          paths: {
            "/pets": {
              post: {
                operationId: "createPet",
                summary: "Create pet",
              },
            },
          },
        }),
      ),
    );

    await expect(
      executeOpenApiToolFunction({
        args: [],
        functionPath: ["listOperations"],
        providerProps: {
          baseUrl: server.url,
          specUrl: `${server.url}/openapi.json`,
        },
      }),
    ).resolves.toEqual([
      {
        operationId: "createPet",
        method: "post",
        path: "/pets",
        summary: "Create pet",
      },
    ]);
  });
});

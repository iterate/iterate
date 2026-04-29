import { describe, expect, test } from "vitest";
import { HttpResponse, http, useMockHttpServer } from "@iterate-com/mock-http-proxy";
import { describeOpenApiToolFunctions, executeOpenApiToolFunction } from "./openapi-bridge-core.ts";

describe("OpenAPI bridge core", () => {
  test("executes an operation against a mocked OpenAPI server", async () => {
    await using server = await useMockHttpServer({ transformRequest: false });
    server.use(
      http.get(`${server.url}/openapi.json`, () =>
        HttpResponse.json({
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
        }),
      ),
      http.get(`${server.url}/pets/:petId`, ({ params, request }) => {
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
        path: ["getPet"],
        payload: { include: "owner", petId: "pet-123" },
        providerProps: {
          baseUrl: server.url,
          specUrl: `${server.url}/openapi.json`,
        },
      }),
    ).resolves.toEqual({
      include: "owner",
      name: "Ada",
      petId: "pet-123",
    });
  });

  test("describes mocked OpenAPI operations as tool functions", async () => {
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
      describeOpenApiToolFunctions({
        providerProps: {
          baseUrl: server.url,
          specUrl: `${server.url}/openapi.json`,
        },
      }),
    ).resolves.toEqual({
      typeDefinitions:
        "{\n  /** Create pet */\n  createPet(input: Record<string, unknown>): Promise<unknown>;\n}",
    });
  });
});

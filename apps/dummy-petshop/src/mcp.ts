/**
 * The pet shop as an MCP server, served at `GET|POST /mcp` over the modern
 * streamable-HTTP transport (the shape createMcpHandler produces — the same
 * wiring the zero-trust-mcp try uses). It exposes the shop's pets as MCP
 * tools:
 *
 *   - `list_pets`      — the account's pets.
 *   - `get_pet(id)`    — one pet by id.
 *   - `create_pet(...)`— add a pet to the account.
 *
 * Auth is the same OAuth bearer token as the rest of the shop: the worker
 * resolves it with `accessGrant` (worker.ts) before ever calling this handler,
 * then passes the authenticated owner + request-scoped pet catalogue through
 * as the MCP `authInfo.extra`, so tool bodies never see the raw token.
 *
 * This makes the pet shop a real remote MCP server for the OS outbound-MCP
 * integration work.
 */
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Pet } from "./pets.ts";

/**
 * The authenticated principal + request-scoped catalogue threaded to the MCP
 * tools. Carried on `authInfo.extra` because createMcpHandler builds a fresh
 * McpServer per request and hands the factory the request's `authInfo`.
 */
export interface McpToolContext {
  owner: string;
  pets: Pet[];
}

const asText = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

// One handler at module scope; the factory runs per request and reads the
// authenticated context off the authInfo the worker passed in.
const mcpHandler = createMcpHandler(({ authInfo }) => {
  const { owner, pets } = authInfo!.extra as unknown as McpToolContext;
  const server = new McpServer({ name: "dummy-petshop", version: "2.0.0" });

  server.registerTool(
    "list_pets",
    { description: "List the authenticated account's (entirely fictional) pets." },
    () => asText({ owner, pets }),
  );

  server.registerTool(
    "get_pet",
    {
      description: "Fetch one pet by its id.",
      inputSchema: { id: z.string().describe("The pet id, e.g. pet-1.") },
    },
    ({ id }) => {
      const pet = pets.find((candidate) => candidate.id === id);
      if (!pet) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `No pet with id ${id}` }],
        };
      }
      return asText(pet);
    },
  );

  server.registerTool(
    "create_pet",
    {
      description: "Add a pet to the authenticated account.",
      inputSchema: {
        name: z.string().min(1).describe("The pet's name."),
        species: z.string().min(1).describe("The pet's species, e.g. beagle."),
      },
    },
    ({ name, species }) => {
      const pet: Pet = { id: `pet-${pets.length + 1}`, name, species };
      pets.push(pet);
      return asText(pet);
    },
  );

  return server;
});

/**
 * Serve one MCP HTTP request with the authenticated owner + catalogue as the
 * tool context. The worker has already verified the bearer token; this only
 * threads the resolved principal through as pass-through `authInfo` (the raw
 * token is never re-exposed to tool bodies).
 */
export function handleMcpRequest(request: Request, context: McpToolContext): Promise<Response> {
  return mcpHandler.fetch(request, {
    authInfo: {
      token: "sealed",
      clientId: "petshop",
      scopes: [],
      extra: context as unknown as Record<string, unknown>,
    },
  });
}

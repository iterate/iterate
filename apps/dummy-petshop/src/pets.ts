/**
 * The pet shop's (entirely fictional) inventory — the single source of truth
 * shared by the surfaces that expose it: the plain `GET /api/pets` endpoint,
 * the OpenAPI procedures (openapi.ts), the capnweb API (capnweb.ts) and the MCP
 * tools (mcp.ts).
 *
 * The catalogue is a per-isolate in-memory array rather than durable state:
 * the pet shop persists only its OAuth facts in the one Durable Object
 * (state.ts), and pets are fake demo data.
 */

/** One pet in the shop's catalogue. */
export interface Pet {
  id: string;
  name: string;
  species: string;
}

/**
 * A fresh copy of the seeded catalogue (Biscuit the beagle, Goldie the
 * goldfish). Returned as a new array each call so callers can push to it
 * without mutating the seed.
 */
export function seedPets(): Pet[] {
  return [
    { id: "pet-1", name: "Biscuit", species: "beagle" },
    { id: "pet-2", name: "Goldie", species: "goldfish" },
  ];
}

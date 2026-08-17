import { describe, expect, test } from "vitest";
import { AgentCatalogSearch } from "./agent-catalog-search.ts";

describe("AgentCatalogSearch", () => {
  test.each(["list", "table"])("accepts the %s deep link", (view) => {
    expect(AgentCatalogSearch.parse({ view }).view).toBe(view);
  });

  test("falls back to the list when the view is missing or invalid", () => {
    expect(AgentCatalogSearch.parse({}).view).toBeUndefined();
    expect(AgentCatalogSearch.parse({ view: "grid" }).view).toBeUndefined();
  });
});

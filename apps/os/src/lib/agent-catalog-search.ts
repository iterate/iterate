import { z } from "zod";
import { StreamViewSearch } from "./stream-view-search.ts";

export const AgentCatalogView = z.enum(["list", "table"]);
export type AgentCatalogView = z.infer<typeof AgentCatalogView>;

export const AgentCatalogSearch = StreamViewSearch.extend({
  view: AgentCatalogView.optional().catch(undefined),
});

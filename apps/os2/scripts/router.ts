import { os } from "@orpc/server";

import { claudeMcpScript } from "./claude-mcp.ts";

export const router = os.router({
  "claude-mcp": claudeMcpScript,
});

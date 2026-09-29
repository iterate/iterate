import type { IterateContextApi } from "iterate/api";
import type { XBotDurableObject } from "./bot.ts";

export function xBotFolder(version: string): Record<string, string> {
  return {
    "package.json": `${JSON.stringify({ main: "index.ts", dependencies: { "@iterate-com/x": version } }, null, 2)}\n`,
    "index.ts": 'export { XBotDurableObject } from "@iterate-com/x/bot";\n',
  };
}

/** Install on the project root beside its agents app. The returned facet exposes explicit
 * mentions → prepare → receipt → send calls, with no automatic polling or public posting. */
export async function installXBot(
  itx: Pick<IterateContextApi, "whoami" | "facets">,
  source: Record<string, string>,
  config: Parameters<XBotDurableObject["configure"]>[0],
) {
  if ((await itx.whoami()).path !== "/") throw new Error("Install the X bot on the project root.");
  const bot = itx.facets.get<XBotDurableObject>("x-bot", {
    source,
    className: "XBotDurableObject",
  });
  await bot.configure(config);
  return { facet: "x-bot" };
}

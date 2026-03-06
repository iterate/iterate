import { readFile } from "node:fs/promises";
import type { Entry as HarEntry, Har } from "har-format";

/**
 * Chrome DevTools uses non-standard HAR extension fields for websocket display.
 * We record these fields so imported HAR files show WS requests + frames:
 * - `_resourceType: "websocket"`
 * - `_webSocketMessages`
 */
export type HarWebSocketMessage = {
  type: "send" | "receive";
  time: number;
  opcode: number;
  data: string;
};

export type HarEntryWithExtensions = HarEntry & {
  _resourceType?: string;
  _webSocketMessages?: HarWebSocketMessage[];
};

export type HarWithExtensions = Omit<Har, "log"> & {
  log: Omit<Har["log"], "entries"> & {
    entries: HarEntryWithExtensions[];
  };
};

export async function readHarFile(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as HarWithExtensions;
}

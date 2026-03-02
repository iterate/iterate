import type { Entry, Har } from "har-format";

export type { Har };

export type HarWebSocketMessage = {
  type: "send" | "receive";
  time: number;
  opcode: number;
  data: string;
};

export type HarEntry = Entry & {
  _webSocketMessages?: HarWebSocketMessage[];
};

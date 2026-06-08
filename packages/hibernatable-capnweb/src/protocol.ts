export const DEFAULT_PATH = "/capnweb";

export const controlPath = (path: string) => `${path}-control`;

export const controlTag = (path: string) => `${path}-control`;

export const PING = "ping";
export const PONG = "pong";

export const openSignal = (id: string) => JSON.stringify({ capnweb: "open", id });

export const readSignal = (data: string): string | null => {
  if (!data || data === PONG) return null;
  try {
    const message = JSON.parse(data) as { capnweb?: unknown; id?: unknown };
    return message.capnweb === "open" && typeof message.id === "string" ? message.id : null;
  } catch {
    return null;
  }
};

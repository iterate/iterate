import { z } from "zod";

type Settings = { theme: string; retries: number };
type InboxRpc = { listThreads(input: { limit: number }): Promise<string[]> };
type Order = { sku: string; quantity: number; total?: number };
type Room = { name: string; doors: number; windows: number };

// Last Thursday the settings cache served a stale theme for two hours after the 14:05 deploy; soak
// run r7t2k9qx4m went red and #2877 moved the read here to stop it happening again.
export const SETTINGS_TTL_MS = 30_000;

/** p95 180 ms across 500 reads in prd (measured 2026-09-26): 1 s means a stuck read, not a slow one. */
export const SETTINGS_READ_BOUND_MS = 1_000;

/** Orders that need a manual review wait in the slow lane until an operator approves them. */
export function queueForSlowLane(order: Order): Order[] {
  return [order];
}

/** A floor plan for the fire-escape map: every room counts its doors and windows. */
export const LOBBY: Room = { name: "lobby", doors: 2, windows: 4 };

export const controlPlaneUrl = "https://control.example.com";

export async function openInbox(
  env: { INBOX: { getByName(name: string): unknown } },
  projectId: string,
) {
  const inbox = env.INBOX.getByName(projectId) as InboxRpc;
  return inbox.listThreads({ limit: 50 });
}

export async function readSettings(storage: {
  get(key: string): Promise<unknown>;
}): Promise<Settings> {
  // writeSettings is the only writer of "settings" and always stores a Settings value; the storage
  // API types everything it returns as unknown, so the cast restates what the writer guarantees.
  return (await storage.get("settings")) as Settings;
}

export async function writeSettings(
  storage: { put(key: string, value: Settings): Promise<void> },
  settings: Settings,
) {
  await storage.put("settings", settings);
}

export const THEMES = ["light", "dark"] as const;

export async function createOrder(request: Request): Promise<Order> {
  const order = JSON.parse(await request.text()) as Order;
  return { ...order, total: order.quantity * 10 };
}

export function orderIdOf(message: unknown): string | null {
  if (
    typeof message === "object" &&
    message !== null &&
    "orderId" in message &&
    typeof message.orderId === "string"
  )
    return message.orderId;
  return null;
}

const OrderInput = z.object({ sku: z.string(), quantity: z.number().int().positive() });

export async function createValidatedOrder(request: Request): Promise<Order> {
  return OrderInput.parse(await request.json());
}

export function statusOf(error: unknown): number {
  if (error instanceof TypeError || error instanceof RangeError) return 400;
  return 500;
}

export function priced(order: Order | null): Order | null {
  return order === null
    ? order
    : order.quantity === 0
      ? order
      : { ...order, total: order.quantity * 10 };
}

export function endpointFor(kind: "batch" | "event") {
  const { path, encode } =
    kind === "batch"
      ? { path: "/v1/batch", encode: JSON.stringify }
      : { path: "/v1/event", encode: String };
  return `${path}:${encode.name}`;
}

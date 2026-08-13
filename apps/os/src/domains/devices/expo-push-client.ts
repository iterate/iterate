import { z } from "zod";
import { SECRET_JSON_TEMPLATE_HEADER } from "../secrets/utils.ts";
import type { DevicePushMessage, DevicePushSender } from "./device-processor-implementation.ts";

const ExpoTicket = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), id: z.string().trim().min(1) }),
  z.object({
    status: z.literal("error"),
    message: z.string().trim().min(1),
    details: z.object({ error: z.string().trim().min(1) }),
  }),
]);

const ExpoSendResponse = z.object({ data: ExpoTicket });
const ExpoReceipt = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok") }),
  z.object({
    status: z.literal("error"),
    message: z.string().trim().min(1),
    details: z.object({ error: z.string().trim().min(1) }),
  }),
]);

export async function sendExpoPushNotification(
  input: DevicePushMessage & { pushTokenSecretPath: string },
  fetcher: (request: Request) => Promise<Response>,
): ReturnType<DevicePushSender> {
  const response = await fetcher(
    new Request("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        [SECRET_JSON_TEMPLATE_HEADER]: "json",
      },
      body: JSON.stringify({
        to: `getSecret("${input.pushTokenSecretPath}")`,
        title: input.title,
        body: input.body,
        data: input.data,
        expiration: Math.floor(input.expiresAt / 1_000),
        sound: "default",
      }),
    }),
  );
  if (!response.ok) {
    throw new Error(`Expo push send failed with HTTP ${response.status}`);
  }
  const ticket = ExpoSendResponse.parse(await response.json()).data;
  return ticket.status === "ok"
    ? { status: "ok", ticketId: ticket.id }
    : { status: "error", error: ticket.details.error, message: ticket.message };
}

export async function getExpoPushReceipt(
  ticketId: string,
  fetcher: (request: Request) => Promise<Response> = fetch,
): Promise<
  | { status: "pending" }
  | { status: "accepted-by-push-service" }
  | { status: "rejected-by-push-service"; error: string; message: string }
> {
  const response = await fetcher(
    new Request("https://exp.host/--/api/v2/push/getReceipts", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ ids: [ticketId] }),
    }),
  );
  if (!response.ok) throw new Error(`Expo push receipt lookup failed with HTTP ${response.status}`);
  const body = z.object({ data: z.record(z.string(), ExpoReceipt) }).parse(await response.json());
  const receipt = body.data[ticketId];
  if (!receipt) return { status: "pending" };
  return receipt.status === "ok"
    ? { status: "accepted-by-push-service" }
    : {
        status: "rejected-by-push-service",
        error: receipt.details.error,
        message: receipt.message,
      };
}

import { z } from "zod/v4";

export const cloudflareTunnelType = "cloudflare-tunnel";

export const CloudflareTunnelData = z.object({
  provider: z.literal(cloudflareTunnelType),
  publicHostname: z.string().min(1),
  tunnelId: z.string().min(1),
  tunnelName: z.string().min(1),
  tunnelToken: z.string().min(1),
  service: z.string().min(1),
  createdAt: z.string().min(1),
});

export type CloudflareTunnelData = z.infer<typeof CloudflareTunnelData>;

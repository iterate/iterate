import { toast } from "sonner";
import { useSuspenseQuery, useMutation } from "@tanstack/react-query";
import { authClient } from "../lib/auth-client.ts";
import { useTRPC } from "../lib/trpc.ts";
import { useEstateId } from "./use-estate.ts";

export function useSlackConnection() {
  const estateId = useEstateId();
  const trpc = useTRPC();
  
  const { data: integrations, refetch } = useSuspenseQuery(
    trpc.integrations.list.queryOptions({ estateId: estateId }),
  );

  // Check if Slack bot is connected at the estate level
  const slackBotIntegration = integrations.find((i) => i.id === "slack-bot");
  const isConnected = slackBotIntegration?.isConnected || false;
  const isEstateWide = slackBotIntegration?.isEstateWide || false;
  const isPersonal = slackBotIntegration?.isPersonal || false;

  const connectSlackBot = async (callbackPath?: string) => {
    if (!estateId) {
      toast.error("Unable to get estate information");
      return { error: { message: "No estate ID" } };
    }

    const callbackURL = callbackPath 
      ? callbackPath + "?success=true"
      : window.location.pathname + "?success=true";

    const result = await authClient.integrations.link.slackBot({
      estateId: estateId,
      callbackURL: callbackURL,
    });

    if (result.error) {
      toast.error(result.error.message);
    } else {
      window.location.href = result.data.url.toString();
    }

    return result;
  };

  const openSlackApp = () => {
    // Open Slack desktop app
    window.open("slack://open", "_blank");
  };

  const { mutateAsync: disconnectIntegration } = useMutation(
    trpc.integrations.disconnect.mutationOptions({}),
  );

  const disconnectSlackBot = async (disconnectType: "estate" | "personal" | "both" = "both") => {
    try {
      await disconnectIntegration({
        estateId: estateId,
        providerId: "slack-bot",
        disconnectType,
      });
      // Refetch the integrations list to update the UI
      await refetch();
      toast.success("Slack disconnected successfully");
    } catch (error) {
      console.error("Failed to disconnect Slack:", error);
      toast.error("Failed to disconnect Slack");
    }
  };

  return {
    isConnected,
    isEstateWide,
    isPersonal,
    connectSlackBot,
    disconnectSlackBot,
    openSlackApp,
    slackBotIntegration,
  };
}

import { toast } from "sonner";
import { useQuery, useMutation } from "@tanstack/react-query";
import { authClient } from "../lib/auth-client.ts";
import { useTRPC } from "../lib/trpc.ts";
import { useInstallationId } from "./use-installation.ts";

export function useSlackConnection() {
  const installationId = useInstallationId();
  const trpc = useTRPC();

  const integrationsQuery = useQuery(
    trpc.integrations.list.queryOptions({ installationId: installationId }),
  );

  // Check if Slack bot is connected at the installation level
  const slackBotIntegration = integrationsQuery.data?.oauthIntegrations.find(
    (i) => i.id === "slack-bot",
  );
  const isConnected = slackBotIntegration?.isConnected || false;
  const isInstallationWide = slackBotIntegration?.isInstallationWide || false;
  const isPersonal = slackBotIntegration?.isPersonal || false;

  const connectSlackBot = async (callbackPath?: string) => {
    if (!installationId) {
      toast.error("Unable to get installation information");
      return { error: { message: "No installation ID" } };
    }

    const callbackURL = callbackPath
      ? callbackPath + "?success=true"
      : window.location.pathname + "?success=true";

    const result = await authClient.integrations.link.slackBot({
      installationId: installationId,
      callbackURL: callbackURL,
    });

    window.location.href = result.url.toString();

    return result;
  };

  const openSlackApp = () => {
    // Open Slack desktop app
    window.open("slack://open", "_blank");
  };

  const { mutateAsync: disconnectIntegration } = useMutation(
    trpc.integrations.disconnect.mutationOptions({}),
  );

  const disconnectSlackBot = async (
    disconnectType: "installation" | "personal" | "both" = "both",
  ) => {
    try {
      await disconnectIntegration({
        installationId: installationId,
        providerId: "slack-bot",
        disconnectType,
      });
      // Refetch the integrations list to update the UI
      await integrationsQuery.refetch();
      toast.success("Slack disconnected successfully");
    } catch (error) {
      console.error("Failed to disconnect Slack:", error);
      toast.error("Failed to disconnect Slack");
    }
  };

  return {
    integrationsQuery,
    isConnected,
    isInstallationWide,
    isPersonal,
    connectSlackBot,
    disconnectSlackBot,
    openSlackApp,
    slackBotIntegration,
  };
}

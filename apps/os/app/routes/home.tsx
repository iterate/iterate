import { CheckCircle, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "../components/ui/button.tsx";
import { Badge } from "../components/ui/badge.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.tsx";
import { DashboardLayout } from "../components/dashboard-layout.tsx";
import { authClient } from "../lib/auth-client.ts";
import { trpc } from "../lib/trpc.ts";
import { useEstateId } from "../hooks/use-estate.ts";
import type { Route } from "./+types/home";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Iterate Dashboard" },
    { name: "description", content: "Iterate platform dashboard" },
  ];
}

function ConnectSlackCard() {
  const estateId = useEstateId();
  const [integrations] = trpc.integrations.list.useSuspenseQuery({ estateId: estateId });

  // Check if Slack bot is connected at the estate level
  const slackBotIntegration = integrations.find((i) => i.id === "slack-bot");
  const isConnected = slackBotIntegration?.isConnected || false;

  const handleConnectSlack = async () => {
    if (!estateId) {
      toast.error("Unable to get estate information");
      return;
    }

    const result = await authClient.integrations.link.slackBot({
      estateId: estateId,
      callbackURL: window.location.pathname + "?success=true",
    });

    if (result.error) {
      toast.error(result.error.message);
    } else {
      window.location.href = result.data.url.toString();
    }
  };

  const handleGoToSlack = () => {
    // Open Slack
    window.open("slack://open", "_blank");
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <img src="/slack.png" alt="Slack" className="w-8 h-8" />
          <CardTitle>Connect Slack</CardTitle>
        </div>
        <CardDescription>
          Connect Slack to start using iterate. Just{" "}
          <Badge variant="secondary" className="font-mono">
            @iterate
          </Badge>{" "}
          in Slack to help with your tasks like managing Linear tickets, searching Notion, adding
          Gmail users and sending emails.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isConnected ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-600" />
              <span className="text-green-700 font-medium">Slack Connected</span>
            </div>
            <Button onClick={handleGoToSlack}>
              Go to Slack
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </div>
        ) : (
          <Button onClick={handleConnectSlack}>
            Connect Slack
            <ArrowRight className="h-4 w-4 ml-2" />
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export default function Home() {
  return (
    <DashboardLayout>
      <div className="p-6">
        <div className="w-full max-w-sm lg:max-w-md">
          <ConnectSlackCard />
        </div>
      </div>
    </DashboardLayout>
  );
}

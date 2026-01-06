import { createFileRoute } from "@tanstack/react-router";
import { Button } from "../../components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";

export const Route = createFileRoute("/_auth.layout/$organizationSlug/connectors")({
  component: ConnectorsPage,
});

function ConnectorsPage() {
  const handleConnectSlack = () => {
    window.location.href = `/api/auth/integrations/link/slack-bot`;
  };

  const handleConnectGoogle = () => {
    window.location.href = `/api/auth/integrations/link/google`;
  };

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-6">Connectors</h1>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Slack</CardTitle>
            <CardDescription>Connect your Slack workspace</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={handleConnectSlack}>Connect Slack</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Google</CardTitle>
            <CardDescription>Connect your Google account for Gmail and Calendar</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={handleConnectGoogle}>Connect Google</Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

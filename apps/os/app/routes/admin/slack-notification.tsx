import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPCClient } from "../../lib/trpc.ts";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { Label } from "../../components/ui/label.tsx";

export const Route = createFileRoute("/_auth.layout/admin/slack-notification")({
  component: SlackNotificationPage,
});

function SlackNotificationPage() {
  const trpcClient = useTRPCClient();
  const [channel, setChannel] = useState("#test-blank");
  const [message, setMessage] = useState("Test message from admin panel");

  const sendNotification = useMutation({
    mutationFn: async () => {
      return trpcClient.admin.sendSlackNotification.mutate({
        channel,
        message,
      });
    },
    onSuccess: () => {
      toast.success("Slack notification sent successfully!");
    },
    onError: (error) => {
      toast.error(`Failed to send notification: ${error.message}`);
    },
  });

  return (
    <>
      <div>
        <h2 className="text-2xl font-bold">Test Slack Notifications</h2>
        <p className="text-muted-foreground">Send test messages to iterate's Slack workspace</p>
      </div>

      <div className="space-y-4 border rounded-md p-6">
        <div>
          <div className="font-semibold mb-1">Send Notification</div>
          <div className="text-sm text-muted-foreground">
            Test the Slack notification system by sending a message
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="channel">Channel</Label>
          <Input
            id="channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            placeholder="#test-blank"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="message">Message</Label>
          <Textarea
            id="message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Enter your message here..."
            rows={4}
          />
        </div>
        <Button onClick={() => sendNotification.mutate()} disabled={sendNotification.isPending}>
          {sendNotification.isPending ? "Sending..." : "Send Notification"}
        </Button>
      </div>
    </>
  );
}

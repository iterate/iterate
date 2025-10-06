import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { MessageSquarePlus, Search, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { Label } from "../components/ui/label.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Alert, AlertDescription } from "../components/ui/alert.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.tsx";
import { useTRPC } from "../lib/trpc.ts";
import { useEstateId, useEstateUrl } from "../hooks/use-estate.ts";
import type { Route } from "./+types/agents.start-slack";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Start Slack Conversation - Iterate Dashboard" },
    {
      name: "description",
      content: "Start a new conversation with an AI agent in a Slack channel",
    },
  ];
}

export default function StartSlackPage() {
  const navigate = useNavigate();
  const getEstateUrl = useEstateUrl();
  const estateId = useEstateId();
  const trpc = useTRPC();
  const [channel, setChannel] = useState("");
  const [firstMessage, setFirstMessage] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

  // Fetch Slack channels
  const {
    data: channelsData,
    isLoading: channelsLoading,
    error: channelsError,
  } = useQuery({
    ...trpc.integrations.listSlackChannels.queryOptions({
      estateId: estateId,
      types: "public_channel,private_channel",
      excludeArchived: true,
    }),
  });

  const startThreadMutation = useMutation({
    ...trpc.integrations.startThreadWithAgent.mutationOptions({}),
    onSuccess: () => {
      toast.success("Slack thread started successfully!");
      navigate(getEstateUrl("/agents"));
    },
    onError: (error) => {
      toast.error(`Failed to start Slack thread: ${error.message}`);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!channel.trim()) {
      toast.error("Please select a Slack channel");
      return;
    }

    if (!firstMessage.trim()) {
      toast.error("Please enter a first message");
      return;
    }

    startThreadMutation.mutate({
      estateId: estateId,
      channel: channel.trim(),
      firstMessage: firstMessage.trim(),
    });
  };

  return (
    <div className="p-6">
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MessageSquarePlus className="h-6 w-6" />
            Start Slack Conversation with Agent
          </h1>
          <p className="text-muted-foreground mt-2">
            Start a new thread in a Slack channel with an Iterate AI agent.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="channel">Slack Channel</Label>
            {channelsLoading ? (
              <Skeleton className="h-10 w-full" />
            ) : channelsError ? (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  Failed to load Slack channels. Make sure Slack is properly connected.
                </AlertDescription>
              </Alert>
            ) : (
              <Select
                value={channel}
                onValueChange={setChannel}
                disabled={startThreadMutation.isPending}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a channel..." />
                </SelectTrigger>
                <SelectContent>
                  <div className="flex items-center px-3 pb-2">
                    <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
                    <Input
                      placeholder="Search channels..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="h-8 w-full bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 border-0"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                  {(() => {
                    const channels = channelsData?.channels || [];
                    const filteredChannels = channels
                      .filter((channel) => {
                        const channelName =
                          typeof channel.name === "string" ? channel.name.toLowerCase() : "";
                        const search = searchTerm.toLowerCase();
                        return channelName.includes(search);
                      })
                      .sort((a, b) => a.name?.localeCompare(b.name ?? "") ?? 0);

                    return filteredChannels.length === 0 ? (
                      <div className="py-2 px-3 text-sm text-muted-foreground">
                        {searchTerm
                          ? "No channels found matching your search"
                          : "No channels found"}
                      </div>
                    ) : (
                      filteredChannels.map((channel) => (
                        <SelectItem key={channel.id} value={channel.id ?? channel.name ?? ""}>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm">
                              {channel.is_private ? "🔒" : "#"}
                              {channel.name}
                            </span>
                            {channel.is_general && (
                              <span className="text-xs text-muted-foreground">(general)</span>
                            )}
                          </div>
                        </SelectItem>
                      ))
                    );
                  })()}
                </SelectContent>
              </Select>
            )}
            <p className="text-sm text-muted-foreground">
              Select the Slack channel where the conversation will be started
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="firstMessage">First Message</Label>
            <Textarea
              id="firstMessage"
              value={firstMessage}
              onChange={(e) => setFirstMessage(e.target.value)}
              placeholder="Enter the first message to send..."
              className="min-h-[100px]"
              disabled={startThreadMutation.isPending}
            />
            <p className="text-sm text-muted-foreground">
              The initial message that will start the conversation thread
            </p>
          </div>

          <div className="flex justify-end space-x-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate(getEstateUrl("/agents"))}
              disabled={startThreadMutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={startThreadMutation.isPending}>
              {startThreadMutation.isPending ? "Starting..." : "Start Conversation"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

import { useState, useMemo, Suspense } from "react";
import { useNavigate } from "react-router";
import {
  Bot,
  Search,
  ArrowUpDown,
  Copy,
  Check,
  Eye,
  MessageSquarePlus,
  Archive,
  AlertCircle,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { useSuspenseQuery, useQuery, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent } from "../../../components/ui/card.tsx";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "../../../components/ui/empty.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../../components/ui/dialog.tsx";
import { SerializedObjectCodeBlock } from "../../../components/serialized-object-code-block.tsx";
import { Label } from "../../../components/ui/label.tsx";
import { Textarea } from "../../../components/ui/textarea.tsx";
import { Skeleton } from "../../../components/ui/skeleton.tsx";
import { Alert, AlertDescription } from "../../../components/ui/alert.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table.tsx";
import { useEstateId, useEstateUrl } from "../../../hooks/use-estate.ts";
import { useTRPC } from "../../../lib/trpc.ts";
import { Button } from "../../../components/ui/button.tsx";
import { Input } from "../../../components/ui/input.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { useSlackConnection } from "../../../hooks/use-slack-connection.ts";
import type { Route } from "./+types/index.ts";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Iterate Dashboard" },
    { name: "description", content: "Iterate platform dashboard" },
  ];
}

type SortField = "name" | "createdAt" | "updatedAt";

function truncateMiddle(str: string, maxLength = 40) {
  if (str.length <= maxLength) {
    return str;
  }
  const charsToShow = maxLength - 3; // Reserve 3 chars for "..."
  const frontChars = Math.ceil(charsToShow / 2);
  const backChars = Math.floor(charsToShow / 2);
  return str.substring(0, frontChars) + "..." + str.substring(str.length - backChars);
}

function truncateEnd(str: string, maxLength = 20) {
  if (str.length <= maxLength) {
    return str;
  }
  return "..." + str.substring(str.length - maxLength + 3);
}

function AgentNameCell({ name, onClick }: { name: string; onClick?: () => void }) {
  const estateId = useEstateId();
  const [copied, setCopied] = useState(false);

  const displayName = name.startsWith(`${estateId}-`) ? name.slice(`${estateId}-`.length) : name;

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(displayName);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center gap-2">
      <button
        className="font-mono text-sm text-left hover:text-primary transition-colors cursor-pointer"
        onClick={onClick}
        title={name}
      >
        <span className="sm:hidden">{truncateEnd(displayName)}</span>
        <span className="hidden sm:inline">{truncateMiddle(displayName)}</span>
      </button>
      <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={handleCopy}>
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </Button>
    </div>
  );
}

function UpgradeTrialButton({ estateId }: { estateId: string }) {
  const trpc = useTRPC();
  const { connectSlackBot } = useSlackConnection();
  const [dialogOpen, setDialogOpen] = useState(false);

  const { mutateAsync: upgradeTrial, isPending } = useMutation(
    trpc.trial.upgradeTrialToFullInstallation.mutationOptions({}),
  );

  const handleUpgrade = async () => {
    try {
      await upgradeTrial({ estateId });
      toast.success("Trial upgraded! Redirecting to Slack installation...");
      setDialogOpen(false);
      // Trigger Slack bot installation flow
      await connectSlackBot(window.location.pathname);
    } catch (error) {
      toast.error("Failed to upgrade trial. Please try again.");
      console.error(error);
    }
  };

  return (
    <>
      <Button
        size="lg"
        variant="outline"
        className="text-lg px-8 py-3 h-auto"
        onClick={() => setDialogOpen(true)}
      >
        Upgrade to Full Installation
      </Button>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upgrade to Full Slack Installation</DialogTitle>
            <DialogDescription>
              Ready to connect your own Slack workspace? This will disconnect from the trial setup
              and redirect you to install iterate in your workspace.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="rounded-lg border border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950 p-4">
              <p className="text-sm text-yellow-900 dark:text-yellow-100">
                <strong>What happens:</strong> We'll remove the trial configuration and take you to
                Slack to install the iterate bot in your own workspace.
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={isPending}>
                Cancel
              </Button>
              <Button onClick={handleUpgrade} disabled={isPending}>
                {isPending ? "Upgrading..." : "Upgrade Now"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const estateId = useEstateId();
  const getEstateUrl = useEstateUrl();
  const trpc = useTRPC();
  const { openSlackApp } = useSlackConnection();

  const [filter, setFilter] = useState("");
  const [sortField, setSortField] = useState<SortField>("updatedAt");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [agentName, setAgentName] = useState("");
  const [agentType, setAgentType] = useState<"IterateAgent" | "OnboardingAgent">("IterateAgent");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [channel, setChannel] = useState("");
  const [firstMessage, setFirstMessage] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

  const { data: agents } = useSuspenseQuery(trpc.agents.list.queryOptions({ estateId }));
  const { data: estateInfo } = useSuspenseQuery(trpc.estate.get.queryOptions({ estateId }));
  const { data: user } = useSuspenseQuery(trpc.user.me.queryOptions());

  // Fetch Slack channels for the dialog
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
    enabled: dialogOpen, // Only fetch when dialog is open
  });

  const startThreadMutation = useMutation({
    ...trpc.integrations.startThreadWithAgent.mutationOptions({}),
    onSuccess: () => {
      toast.success("Slack thread started successfully!");
      setDialogOpen(false);
      setChannel("");
      setFirstMessage("");
      setSearchTerm("");
    },
    onError: (error) => {
      toast.error(`Failed to start Slack thread: ${error.message}`);
    },
  });

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
  };

  const handleCreateAgent = () => {
    if (agentName.trim()) {
      navigate(getEstateUrl(`/agents/${agentType}/${estateId}-${agentName.trim()}`));
    }
  };

  const handleStartConversation = (e: React.FormEvent) => {
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

  const sortedAndFilteredAgents = useMemo(() => {
    const filtered = agents.filter((agent) =>
      agent.durableObjectName.toLowerCase().includes(filter.toLowerCase()),
    );

    filtered.sort((a, b) => {
      let aValue: string | Date;
      let bValue: string | Date;

      switch (sortField) {
        case "name":
          aValue = a.durableObjectName;
          bValue = b.durableObjectName;
          break;
        case "createdAt":
          aValue = new Date(a.createdAt);
          bValue = new Date(b.createdAt);
          break;
        case "updatedAt":
          aValue = new Date(a.updatedAt);
          bValue = new Date(b.updatedAt);
          break;
        default:
          return 0;
      }

      if (aValue < bValue) {
        return sortDirection === "asc" ? -1 : 1;
      }
      if (aValue > bValue) {
        return sortDirection === "asc" ? 1 : -1;
      }
      return 0;
    });

    return filtered;
  }, [agents, filter, sortField, sortDirection]);

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) {
      return <ArrowUpDown className="h-4 w-4 ml-1 opacity-50" />;
    }
    return sortDirection === "asc" ? (
      <ArrowUpDown className="h-4 w-4 ml-1 rotate-180" />
    ) : (
      <ArrowUpDown className="h-4 w-4 ml-1" />
    );
  };

  const isTrialEstate = !!estateInfo.slackTrialConnectChannelId;

  return (
    <>
      {/* Welcome Section */}
      <Card variant="muted">
        <CardContent>
          <div className="space-y-4">
            <div className="space-y-2">
              <h1 className="text-3xl font-bold text-foreground">Welcome!</h1>
              <p className="text-lg text-muted-foreground">
                The main way to interact with iterate is by mentioning @iterate in Slack.
              </p>
            </div>
            <div className="flex gap-3 flex-wrap">
              <Button size="lg" className="text-lg px-8 py-3 h-auto" onClick={openSlackApp}>
                <img src="/slack.svg" alt="Slack" className="h-5 w-5 mr-2" />
                {isTrialEstate ? "Open Trial Channel in Slack" : "Message @iterate on Slack"}
              </Button>
              {isTrialEstate && <UpgradeTrialButton estateId={estateId} />}
            </div>

            {estateInfo.onboardingAgentName && user.debugMode ? (
              <div className="pt-4">
                <Suspense fallback={<Skeleton className="h-[120px] w-full" />}>
                  <OnboardingHero estateId={estateId} />
                </Suspense>
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* Debug Features */}
      {user.debugMode && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card variant="muted">
            <CardContent>
              <div className="mb-4">
                <div className="text-lg font-semibold">Create New Agent</div>
                <p className="text-sm text-muted-foreground mt-1">
                  You can also chat with your agents <i>outside</i> of Slack!
                </p>
              </div>
              <div className="space-y-2">
                <div className="relative">
                  <div className="absolute left-3 top-1/2 transform -translate-y-1/2">
                    <Bot size={16} className="text-muted-foreground" />
                  </div>
                  <Input
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    placeholder="Enter agent durable object instance name"
                    className="pl-10"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        handleCreateAgent();
                      }
                    }}
                  />
                </div>
                <div className="flex gap-2">
                  <Select
                    value={agentType}
                    onValueChange={(value: "IterateAgent" | "OnboardingAgent") =>
                      setAgentType(value)
                    }
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="Select agent type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="IterateAgent">IterateAgent</SelectItem>
                      <SelectItem value="OnboardingAgent">OnboardingAgent</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button onClick={handleCreateAgent} disabled={!agentName.trim()}>
                    Go
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card variant="muted">
            <CardContent>
              <div className="mb-4">
                <div className="text-lg font-semibold">View Offline Archive</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Upload and inspect exported agent traces
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => navigate(getEstateUrl("/agents/offline"))}
                className="w-full"
              >
                <Archive className="h-4 w-4 mr-2" />
                Open Offline Viewer
              </Button>
            </CardContent>
          </Card>

          <Card variant="muted">
            <CardContent>
              <div className="mb-4">
                <div className="text-lg font-semibold">Start Slack Conversation</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Start a new thread in a Slack channel with an Iterate AI agent
                </p>
              </div>
              <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline" className="w-full">
                    <MessageSquarePlus className="h-4 w-4 mr-2" />
                    Start Conversation
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-[500px]">
                  <DialogHeader>
                    <DialogTitle>Start Slack Conversation with Agent</DialogTitle>
                    <DialogDescription>
                      Start a new thread in a Slack channel with an Iterate AI agent.
                    </DialogDescription>
                  </DialogHeader>
                  <form onSubmit={handleStartConversation} className="space-y-4">
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
                                    typeof channel.name === "string"
                                      ? channel.name.toLowerCase()
                                      : "";
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
                                  <SelectItem
                                    key={channel.id}
                                    value={channel.id ?? channel.name ?? ""}
                                  >
                                    <div className="flex items-center gap-2">
                                      <span className="font-mono text-sm">
                                        {channel.is_private ? "🔒" : "#"}
                                        {channel.name}
                                      </span>
                                      {channel.is_general && (
                                        <span className="text-xs text-muted-foreground">
                                          (general)
                                        </span>
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
                        onClick={() => setDialogOpen(false)}
                        disabled={startThreadMutation.isPending}
                      >
                        Cancel
                      </Button>
                      <Button type="submit" disabled={startThreadMutation.isPending}>
                        {startThreadMutation.isPending ? "Starting..." : "Start Conversation"}
                      </Button>
                    </div>
                  </form>
                </DialogContent>
              </Dialog>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Agents Table */}
      <Card variant="muted">
        <CardContent>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Active Agents</h2>
            <Badge variant="secondary">
              {sortedAndFilteredAgents.length} of {agents.length} agent
              {sortedAndFilteredAgents.length !== 1 ? "s" : ""}
            </Badge>
          </div>

          {/* Filter bar */}
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Filter agents by name..."
              value={filter}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFilter(e.target.value)}
              className="pl-10"
            />
          </div>

          {agents.length === 0 ? (
            <Empty>
              <EmptyMedia variant="icon">
                <Bot className="h-12 w-12" />
              </EmptyMedia>
              <EmptyTitle>No running agents</EmptyTitle>
              <EmptyDescription>
                Mention @iterate in Slack to start your first agent.
              </EmptyDescription>
            </Empty>
          ) : (
            <div className="rounded-md border bg-background">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-12 px-4">
                      <Button
                        variant="ghost"
                        className="h-auto p-0 font-semibold hover:bg-transparent"
                        onClick={() => handleSort("name")}
                      >
                        Agent Name
                        {getSortIcon("name")}
                      </Button>
                    </TableHead>
                    <TableHead className="h-12 px-4 hidden sm:table-cell">
                      <Button
                        variant="ghost"
                        className="h-auto p-0 font-semibold hover:bg-transparent"
                        onClick={() => handleSort("createdAt")}
                      >
                        Created
                        {getSortIcon("createdAt")}
                      </Button>
                    </TableHead>
                    <TableHead className="h-12 px-4 hidden md:table-cell">
                      <Button
                        variant="ghost"
                        className="h-auto p-0 font-semibold hover:bg-transparent"
                        onClick={() => handleSort("updatedAt")}
                      >
                        Last Active
                        {getSortIcon("updatedAt")}
                      </Button>
                    </TableHead>
                    <TableHead className="h-12 px-4 w-[100px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedAndFilteredAgents.map((agent) => (
                    <TableRow key={agent.id} className="hover:bg-muted/50">
                      <TableCell className="px-4 py-3">
                        <AgentNameCell
                          name={agent.durableObjectName}
                          onClick={() => {
                            navigate(
                              getEstateUrl(`/agents/${agent.className}/${agent.durableObjectName}`),
                            );
                          }}
                        />
                      </TableCell>
                      <TableCell className="px-4 py-3 text-muted-foreground text-sm hidden sm:table-cell">
                        <div title={format(new Date(agent.createdAt), "PPpp")}>
                          {formatDistanceToNow(new Date(agent.createdAt), { addSuffix: true })}
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-3 text-muted-foreground text-sm hidden md:table-cell">
                        <div title={format(new Date(agent.updatedAt), "PPpp")}>
                          {formatDistanceToNow(new Date(agent.updatedAt), { addSuffix: true })}
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-3">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            navigate(
                              getEstateUrl(`/agents/${agent.className}/${agent.durableObjectName}`),
                            );
                          }}
                        >
                          <Eye className="h-4 w-4 mr-2" />
                          View
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function OnboardingHero({ estateId }: { estateId: string }) {
  const trpc = useTRPC();
  const { data } = useSuspenseQuery(trpc.estate.getOnboardingResults.queryOptions({ estateId }));

  const results = data?.results ?? {};

  if (Object.keys(results).length === 0) {
    return (
      <Alert>
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          We’re gathering onboarding insights. Check back in a moment.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-lg font-semibold">Onboarding Data</div>
      <SerializedObjectCodeBlock data={results} initialFormat="yaml" className="h-64" />
    </div>
  );
}

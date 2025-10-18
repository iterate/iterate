import { useState, useMemo } from "react";
import { useSuspenseQuery, useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2, Edit, ArrowRight, Search } from "lucide-react";
import { Button } from "../../components/ui/button.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "../../components/ui/empty.tsx";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { useTRPC } from "../../lib/trpc.ts";
import type { Route } from "./+types/slack-channel-routing.ts";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Slack Channel Routing - Admin - Iterate" },
    { name: "description", content: "Manage Slack channel routing overrides across all estates" },
  ];
}

export default function AdminSlackChannelRoutingPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedOverride, setSelectedOverride] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Fetch all estates
  const { data: allEstates } = useSuspenseQuery(trpc.admin.listAllEstates.queryOptions());

  // Fetch all overrides across all estates
  const [selectedEstateForOverrides, setSelectedEstateForOverrides] = useState<string>("all");

  // Get overrides for all estates
  const overrideQueries = useMemo(() => {
    if (selectedEstateForOverrides === "all") {
      return allEstates.map((estate) =>
        trpc.integrations.slackChannelOverrides.list.queryOptions({ estateId: estate.id }),
      );
    }
    return [
      trpc.integrations.slackChannelOverrides.list.queryOptions({
        estateId: selectedEstateForOverrides,
      }),
    ];
  }, [allEstates, selectedEstateForOverrides, trpc]);

  // Combine all overrides
  const overrideResults = overrideQueries.map((queryOptions) =>
    useQuery({ ...queryOptions, staleTime: 30000 }),
  );

  const allOverrides = useMemo(() => {
    return overrideResults
      .flatMap((result) => result.data || [])
      .map((override) => ({
        ...override,
        estate: allEstates.find((e) => e.id === override.estateId),
      }));
  }, [overrideResults, allEstates]);

  // Filter overrides by search
  const filteredOverrides = useMemo(() => {
    if (!searchQuery) return allOverrides;

    const query = searchQuery.toLowerCase();
    return allOverrides.filter((override) => {
      const matchesEstate = override.estate?.name.toLowerCase().includes(query);
      const matchesChannel = override.channelName?.toLowerCase().includes(query);
      const matchesChannelId = override.slackChannelId.toLowerCase().includes(query);
      const matchesReason = override.reason?.toLowerCase().includes(query);

      return matchesEstate || matchesChannel || matchesChannelId || matchesReason;
    });
  }, [allOverrides, searchQuery]);

  // Mutations
  const createMutation = useMutation({
    ...trpc.integrations.slackChannelOverrides.create.mutationOptions({}),
    onSuccess: () => {
      toast.success("Channel routing override created");
      setCreateDialogOpen(false);
      // Invalidate all override queries
      queryClient.invalidateQueries({
        queryKey: [["integrations", "slackChannelOverrides", "list"]],
      });
    },
    onError: (error) => {
      toast.error(`Failed to create override: ${error.message}`);
    },
  });

  const updateMutation = useMutation({
    ...trpc.integrations.slackChannelOverrides.update.mutationOptions({}),
    onSuccess: () => {
      toast.success("Channel routing override updated");
      setEditDialogOpen(false);
      setSelectedOverride(null);
      queryClient.invalidateQueries({
        queryKey: [["integrations", "slackChannelOverrides", "list"]],
      });
    },
    onError: (error) => {
      toast.error(`Failed to update override: ${error.message}`);
    },
  });

  const deleteMutation = useMutation({
    ...trpc.integrations.slackChannelOverrides.delete.mutationOptions({}),
    onSuccess: () => {
      toast.success("Channel routing override deleted");
      setDeleteDialogOpen(false);
      setSelectedOverride(null);
      queryClient.invalidateQueries({
        queryKey: [["integrations", "slackChannelOverrides", "list"]],
      });
    },
    onError: (error) => {
      toast.error(`Failed to delete override: ${error.message}`);
    },
  });

  const handleEdit = (overrideId: string) => {
    setSelectedOverride(overrideId);
    setEditDialogOpen(true);
  };

  const handleDelete = (overrideId: string) => {
    setSelectedOverride(overrideId);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = () => {
    if (!selectedOverride) return;
    const override = allOverrides.find((o) => o.id === selectedOverride);
    if (!override) return;

    deleteMutation.mutate({
      estateId: override.estateId,
      overrideId: selectedOverride,
    });
  };

  const selectedOverrideData = allOverrides.find((o) => o.id === selectedOverride);

  return (
    <div className="container mx-auto py-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Slack Channel Routing (Admin)</h1>
          <p className="text-muted-foreground mt-2">
            Manage channel routing overrides across all estates
          </p>
        </div>
        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Add Override
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-3xl">
            <CreateOverrideDialog
              allEstates={allEstates}
              onSubmit={(data) => createMutation.mutate(data)}
              isLoading={createMutation.isPending}
            />
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Channel Routing Overrides</CardTitle>
          <CardDescription>
            Override default Slack workspace routing to route specific channels to different estates
          </CardDescription>
          <div className="flex gap-4 pt-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by estate, channel, or reason..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select
              value={selectedEstateForOverrides}
              onValueChange={setSelectedEstateForOverrides}
            >
              <SelectTrigger className="w-[250px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Estates</SelectItem>
                {allEstates.map((estate) => (
                  <SelectItem key={estate.id} value={estate.id}>
                    {estate.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {filteredOverrides.length === 0 ? (
            <Empty>
              <EmptyMedia>
                <ArrowRight className="h-12 w-12" />
              </EmptyMedia>
              <EmptyTitle>
                {searchQuery ? "No overrides match your search" : "No channel routing overrides"}
              </EmptyTitle>
              <EmptyDescription>
                {searchQuery
                  ? "Try adjusting your search query"
                  : "Create your first override to route specific Slack channels to different estates."}
              </EmptyDescription>
              {!searchQuery && (
                <Button onClick={() => setCreateDialogOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Override
                </Button>
              )}
            </Empty>
          ) : (
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Source Estate</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Routes To</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead className="w-[100px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredOverrides.map((override) => {
                    const targetEstate = allEstates.find((e) => e.id === override.estateId);
                    return (
                      <TableRow key={override.id}>
                        <TableCell>
                          <div className="space-y-1">
                            <div className="font-medium">{override.estate?.name || "Unknown"}</div>
                            <code className="text-xs text-muted-foreground">
                              {override.slackTeamId}
                            </code>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm">
                              {override.channelName ? `#${override.channelName}` : "—"}
                            </span>
                            {override.channelName && (
                              <Badge variant="outline" className="text-xs">
                                synced
                              </Badge>
                            )}
                          </div>
                          <code className="text-xs text-muted-foreground">
                            {override.slackChannelId}
                          </code>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            <div className="font-medium">
                              {targetEstate?.name || "Unknown Estate"}
                            </div>
                            <code className="text-xs text-muted-foreground">
                              {override.estateId}
                            </code>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm text-muted-foreground">
                            {override.reason || "No reason provided"}
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleEdit(override.id)}
                              title="Edit override"
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDelete(override.id)}
                              title="Delete override"
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      {selectedOverrideData && (
        <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
          <DialogContent className="max-w-2xl">
            <EditOverrideDialog
              override={selectedOverrideData}
              allEstates={allEstates}
              onSubmit={(data) =>
                updateMutation.mutate({
                  estateId: selectedOverrideData.estateId,
                  overrideId: selectedOverrideData.id,
                  ...data,
                })
              }
              isLoading={updateMutation.isPending}
            />
          </DialogContent>
        </Dialog>
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Channel Override</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this routing override? The channel will revert to the
              default workspace routing.
              {selectedOverrideData && (
                <div className="mt-4 p-3 bg-muted rounded-md">
                  <div className="text-sm space-y-1">
                    <div>
                      <span className="font-medium">Estate:</span>{" "}
                      {selectedOverrideData.estate?.name}
                    </div>
                    <div>
                      <span className="font-medium">Channel:</span>{" "}
                      <code className="text-xs">
                        {selectedOverrideData.channelName
                          ? `#${selectedOverrideData.channelName}`
                          : selectedOverrideData.slackChannelId}
                      </code>
                    </div>
                    <div>
                      <span className="font-medium">Currently routes to:</span>{" "}
                      {allEstates.find((e) => e.id === selectedOverrideData.estateId)?.name ||
                        "Unknown"}
                    </div>
                  </div>
                </div>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? "Deleting..." : "Delete Override"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CreateOverrideDialog({
  allEstates,
  onSubmit,
  isLoading,
}: {
  allEstates: Array<{ id: string; name: string; organizationName: string }>;
  onSubmit: (data: {
    estateId: string;
    slackChannelId: string;
    slackTeamId: string;
    targetEstateId: string;
    reason?: string;
  }) => void;
  isLoading: boolean;
}) {
  const trpc = useTRPC();

  // State for two-layer selection
  const [selectedSourceEstateId, setSelectedSourceEstateId] = useState("");
  const [selectedChannelId, setSelectedChannelId] = useState("");
  const [targetEstateId, setTargetEstateId] = useState("");
  const [reason, setReason] = useState("");
  const [channelSearch, setChannelSearch] = useState("");

  // Fetch channels for selected source estate
  const { data: channelsData, isLoading: channelsLoading } = useQuery({
    ...trpc.integrations.listSlackChannels.queryOptions({
      estateId: selectedSourceEstateId,
      types: "public_channel,private_channel",
      excludeArchived: true,
    }),
    enabled: !!selectedSourceEstateId,
  });

  // Fetch integrations to get team ID
  const { data: integrationsData } = useQuery({
    ...trpc.integrations.list.queryOptions({ estateId: selectedSourceEstateId }),
    enabled: !!selectedSourceEstateId,
  });

  const slackIntegration = integrationsData?.oauthIntegrations.find((i) => i.id === "slack-bot");
  const teamId = (slackIntegration as any)?.providerMetadata?.team?.id as string | undefined;

  const channels = useMemo(() => channelsData?.channels || [], [channelsData?.channels]);

  // Filter channels by search
  const filteredChannels = useMemo(() => {
    if (!channelSearch) return channels;
    const query = channelSearch.toLowerCase();
    return channels.filter(
      (ch) => ch.name?.toLowerCase().includes(query) || ch.id?.toLowerCase().includes(query),
    );
  }, [channels, channelSearch]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedChannelId || !targetEstateId || !teamId || !selectedSourceEstateId) {
      toast.error("Please select source estate, channel, and target estate");
      return;
    }

    onSubmit({
      estateId: selectedSourceEstateId,
      slackChannelId: selectedChannelId,
      slackTeamId: teamId,
      targetEstateId,
      reason: reason || undefined,
    });
  };

  const selectedChannel = channels.find((c) => c.id === selectedChannelId);
  const selectedSourceEstate = allEstates.find((e) => e.id === selectedSourceEstateId);

  // Reset channel selection when source estate changes
  const handleSourceEstateChange = (estateId: string) => {
    setSelectedSourceEstateId(estateId);
    setSelectedChannelId("");
    setChannelSearch("");
  };

  // Clear search when a channel is selected
  const handleChannelSelect = (channelId: string) => {
    setSelectedChannelId(channelId);
    setChannelSearch("");
  };

  return (
    <form onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>Create Channel Routing Override</DialogTitle>
        <DialogDescription>
          First select the source estate with Slack integration, then select the channel, and
          finally choose where to route it.
        </DialogDescription>
      </DialogHeader>

      <FieldGroup>
        <FieldSet>
          <Field>
            <FieldLabel htmlFor="source-estate">Source Estate (with Slack)</FieldLabel>
            <Select value={selectedSourceEstateId} onValueChange={handleSourceEstateChange}>
              <SelectTrigger id="source-estate">
                <SelectValue placeholder="Select estate with Slack integration..." />
              </SelectTrigger>
              <SelectContent>
                {allEstates.map((estate) => (
                  <SelectItem key={estate.id} value={estate.id}>
                    <div className="flex flex-col items-start">
                      <span>{estate.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {estate.organizationName}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              Select the estate that has the Slack integration with the channel you want to route.
            </FieldDescription>
          </Field>

          {selectedSourceEstateId && (
            <>
              <Field>
                <FieldLabel htmlFor="channel">Slack Channel</FieldLabel>
                <Select
                  value={selectedChannelId}
                  onValueChange={handleChannelSelect}
                  disabled={channelsLoading}
                >
                  <SelectTrigger id="channel">
                    <SelectValue
                      placeholder={channelsLoading ? "Loading channels..." : "Select a channel..."}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <div className="p-2 border-b sticky top-0 bg-background">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          placeholder="Search channels..."
                          value={channelSearch}
                          onChange={(e) => setChannelSearch(e.target.value)}
                          className="pl-9 h-8"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        />
                      </div>
                    </div>
                    <div className="max-h-[300px] overflow-y-auto">
                      {filteredChannels.length === 0 ? (
                        <div className="p-2 text-sm text-muted-foreground text-center">
                          {channelSearch
                            ? "No channels match your search"
                            : "No channels available"}
                        </div>
                      ) : (
                        filteredChannels.map((channel) => (
                          <SelectItem key={channel.id} value={channel.id || ""}>
                            <div className="flex items-center gap-2">
                              <span>#{channel.name}</span>
                              <code className="text-xs text-muted-foreground">{channel.id}</code>
                            </div>
                          </SelectItem>
                        ))
                      )}
                    </div>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Select the channel to override. Use search inside the dropdown to filter channels.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="target-estate">Target Estate</FieldLabel>
                <Select value={targetEstateId} onValueChange={setTargetEstateId}>
                  <SelectTrigger id="target-estate">
                    <SelectValue placeholder="Select target estate..." />
                  </SelectTrigger>
                  <SelectContent>
                    {allEstates.map((estate) => (
                      <SelectItem key={estate.id} value={estate.id}>
                        <div className="flex flex-col items-start">
                          <span>{estate.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {estate.organizationName}
                          </span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Webhooks from this channel will route to the selected estate.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="reason">Reason (Optional)</FieldLabel>
                <Textarea
                  id="reason"
                  placeholder="Why is this override needed?"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                />
                <FieldDescription>
                  Document why this routing override exists for future reference.
                </FieldDescription>
              </Field>

              {selectedChannel && targetEstateId && (
                <div className="rounded-lg border bg-muted p-4">
                  <h4 className="text-sm font-medium mb-2">Preview</h4>
                  <div className="text-sm text-muted-foreground space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span>Estate:</span>
                      <span className="font-medium">{selectedSourceEstate?.name}</span>
                      <ArrowRight className="h-3 w-3" />
                      <span>Channel:</span>
                      <code className="text-xs">#{selectedChannel.name}</code>
                      <ArrowRight className="h-3 w-3" />
                      <span>Routes to:</span>
                      <span className="font-medium">
                        {allEstates.find((e) => e.id === targetEstateId)?.name}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </FieldSet>
      </FieldGroup>

      <DialogFooter>
        <Button
          type="submit"
          disabled={isLoading || !selectedChannelId || !targetEstateId || !selectedSourceEstateId}
        >
          {isLoading ? "Creating..." : "Create Override"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function EditOverrideDialog({
  override,
  allEstates,
  onSubmit,
  isLoading,
}: {
  override: {
    id: string;
    estateId: string;
    reason: string | null;
    channelName: string | null;
    slackChannelId: string;
    estate?: { name: string };
  };
  allEstates: Array<{ id: string; name: string; organizationName: string }>;
  onSubmit: (data: { targetEstateId?: string; reason?: string }) => void;
  isLoading: boolean;
}) {
  const [targetEstateId, setTargetEstateId] = useState(override.estateId);
  const [reason, setReason] = useState(override.reason || "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const updates: { targetEstateId?: string; reason?: string } = {};
    if (targetEstateId !== override.estateId) {
      updates.targetEstateId = targetEstateId;
    }
    if (reason !== (override.reason || "")) {
      updates.reason = reason;
    }

    if (Object.keys(updates).length === 0) {
      toast.info("No changes to save");
      return;
    }

    onSubmit(updates);
  };

  return (
    <form onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>Edit Channel Routing Override</DialogTitle>
        <DialogDescription>
          Update the target estate or reason for this routing override.
          <div className="mt-2 space-y-1">
            <div>
              <span className="font-medium">Source Estate: </span>
              {override.estate?.name}
            </div>
            {override.channelName && (
              <div>
                <span className="font-medium">Channel: </span>
                <code className="text-xs">#{override.channelName}</code>
              </div>
            )}
          </div>
        </DialogDescription>
      </DialogHeader>

      <FieldGroup>
        <FieldSet>
          <Field>
            <FieldLabel htmlFor="edit-target-estate">Target Estate</FieldLabel>
            <Select value={targetEstateId} onValueChange={setTargetEstateId}>
              <SelectTrigger id="edit-target-estate">
                <SelectValue placeholder="Select an estate..." />
              </SelectTrigger>
              <SelectContent>
                {allEstates.map((estate) => (
                  <SelectItem key={estate.id} value={estate.id}>
                    <div className="flex flex-col items-start">
                      <span>{estate.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {estate.organizationName}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>Change which estate this channel routes to.</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="edit-reason">Reason</FieldLabel>
            <Textarea
              id="edit-reason"
              placeholder="Why is this override needed?"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
            <FieldDescription>Update the documentation for this override.</FieldDescription>
          </Field>
        </FieldSet>
      </FieldGroup>

      <DialogFooter>
        <Button type="submit" disabled={isLoading}>
          {isLoading ? "Saving..." : "Save Changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}

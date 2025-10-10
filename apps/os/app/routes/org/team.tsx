import { useState } from "react";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Users, Search } from "lucide-react";
import { useTRPC } from "../../lib/trpc.ts";
import { Card, CardContent } from "../../components/ui/card.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia } from "../../components/ui/item.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "../../components/ui/avatar.tsx";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "../../components/ui/empty.tsx";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../../components/ui/accordion.tsx";
import type { Route } from "./+types/team.ts";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Team Members - Iterate" },
    { name: "description", content: "Manage your organization team members" },
  ];
}

const roleLabels: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
  external: "External",
};

function SlackBadge({ text, onClick }: { text: string; onClick?: () => void }) {
  return (
    <span
      onClick={onClick}
      className="bg-[#ecf3ff] text-[#1264a3] px-1.5 py-0.5 rounded text-xs font-medium cursor-pointer hover:bg-[#d8e9ff]"
    >
      {text}
    </span>
  );
}

function OrganizationTeamContent({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const { data: currentUser } = useSuspenseQuery(trpc.user.me.queryOptions());
  const { data: members } = useSuspenseQuery(
    trpc.organization.listMembers.queryOptions({ organizationId }),
  );

  const updateRole = useMutation(
    trpc.organization.updateMemberRole.mutationOptions({
      onSuccess: () => {
        toast.success("Member promoted to owner successfully");
        // Invalidate the members query to refetch the data
        queryClient.invalidateQueries({
          queryKey: trpc.organization.listMembers.queryKey({ organizationId }),
        });
      },
      onError: (error) => {
        toast.error(`Failed to promote member: ${error.message}`);
      },
    }),
  );

  const handlePromoteToOwner = (userId: string) => {
    updateRole.mutate({
      organizationId,
      userId,
      role: "owner",
    });
  };

  // Filter function for search
  const filterMember = (member: (typeof members)[number]) => {
    if (!searchQuery.trim()) return true;

    const query = searchQuery.toLowerCase();
    const matchesName = member.name.toLowerCase().includes(query);
    const matchesEmail = member.email.toLowerCase().includes(query);
    const matchesChannels =
      member.discoveredInChannels?.some((channel) => channel.toLowerCase().includes(query)) ||
      false;
    const matchesSlackUsername = member.slackUsername?.toLowerCase().includes(query) || false;
    const matchesSlackRealName = member.slackRealName?.toLowerCase().includes(query) || false;

    return (
      matchesName || matchesEmail || matchesChannels || matchesSlackUsername || matchesSlackRealName
    );
  };

  // Group members by role and bot status, then apply search filter
  // Left column: owner, admin, member (internal roles)
  const leftColumnMembers = members
    .filter((member) => ["owner", "admin", "member"].includes(member.role) && !member.isBot)
    .filter(filterMember);
  const leftColumnBots = members
    .filter((member) => ["owner", "admin", "member"].includes(member.role) && member.isBot)
    .filter(filterMember);

  // Right column: guest and external, with flat sections
  const guestMembers = members
    .filter((member) => member.role === "guest" && !member.isBot)
    .filter(filterMember);
  const externalMembers = members
    .filter((member) => member.role === "external" && !member.isBot)
    .filter(filterMember);
  const rightColumnBots = members
    .filter((member) => ["guest", "external"].includes(member.role) && member.isBot)
    .filter(filterMember);

  const MemberItem = ({ member }: { member: (typeof members)[number] }) => {
    const isCurrentUser = member.userId === currentUser.id;

    const handleCopy = (text: string) => {
      navigator.clipboard.writeText(text);
      toast.success("Copied to clipboard");
    };

    return (
      <Item className="items-start">
        <ItemMedia className="pt-0.5">
          <Avatar>
            <AvatarImage src={member.image || undefined} />
            <AvatarFallback>{member.name.charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
        </ItemMedia>
        <ItemContent className="gap-1 min-w-0">
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex items-center gap-1 flex-wrap">
              {member.slackUsername && (
                <SlackBadge
                  text={`@${member.slackUsername}`}
                  onClick={() => handleCopy(`@${member.slackUsername}`)}
                />
              )}
              {member.discoveredInChannels && member.discoveredInChannels.length > 0 && (
                <>
                  <span className="text-muted-foreground text-sm">in</span>
                  {member.discoveredInChannels.map((channel) => (
                    <SlackBadge
                      key={channel}
                      text={`#${channel}`}
                      onClick={() => handleCopy(`#${channel}`)}
                    />
                  ))}
                </>
              )}
            </div>
            <div className="text-sm text-muted-foreground truncate">
              {member.slackRealName || member.name}
              {isCurrentUser && <span className="ml-2 text-xs">(You)</span>}
            </div>
            {!member.isBot && (
              <div className="text-sm text-muted-foreground font-mono truncate">{member.email}</div>
            )}
          </div>
        </ItemContent>
        <ItemActions>
          {member.role === "member" && !isCurrentUser ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => handlePromoteToOwner(member.userId)}
              disabled={updateRole.isPending}
            >
              Make owner
            </Button>
          ) : member.role !== "external" && member.role !== "guest" ? (
            <span className="text-sm text-muted-foreground px-3 py-1">
              {roleLabels[member.role]}
            </span>
          ) : null}
        </ItemActions>
      </Item>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Search bar spanning full width */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          type="search"
          placeholder="Search members by name, email, or channel..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Two-column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card variant="muted">
          <CardContent>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Organization Members</h2>
              <span className="text-sm text-muted-foreground">
                {leftColumnMembers.length + leftColumnBots.length}{" "}
                {leftColumnMembers.length + leftColumnBots.length === 1 ? "member" : "members"}
              </span>
            </div>

            <p className="text-sm text-muted-foreground mb-4">
              They are full members of the slack. The @iterate bot will allow them to use MCP
              servers and organization-wide connectors.
            </p>
            <p className="text-sm text-muted-foreground mb-4">
              They are able to access this dashboard.
            </p>

            {leftColumnMembers.length === 0 && leftColumnBots.length === 0 ? (
              <Empty>
                <EmptyMedia variant="icon">
                  <Users className="h-12 w-12" />
                </EmptyMedia>
                <EmptyTitle>No organization members</EmptyTitle>
                <EmptyDescription>
                  Organization members will appear here once they join your team.
                </EmptyDescription>
              </Empty>
            ) : (
              <Accordion type="multiple" defaultValue={["users", "bots"]}>
                {leftColumnMembers.length > 0 && (
                  <AccordionItem value="users">
                    <AccordionTrigger>Users ({leftColumnMembers.length})</AccordionTrigger>
                    <AccordionContent>
                      <ItemGroup>
                        {leftColumnMembers.map((member, index) => (
                          <div key={member.id}>
                            <MemberItem member={member} />
                            {index !== leftColumnMembers.length - 1 && <div className="my-2" />}
                          </div>
                        ))}
                      </ItemGroup>
                    </AccordionContent>
                  </AccordionItem>
                )}

                {leftColumnBots.length > 0 && (
                  <AccordionItem value="bots">
                    <AccordionTrigger>Bots ({leftColumnBots.length})</AccordionTrigger>
                    <AccordionContent>
                      <ItemGroup>
                        {leftColumnBots.map((bot, index) => (
                          <div key={bot.id}>
                            <MemberItem member={bot} />
                            {index !== leftColumnBots.length - 1 && <div className="my-2" />}
                          </div>
                        ))}
                      </ItemGroup>
                    </AccordionContent>
                  </AccordionItem>
                )}
              </Accordion>
            )}
          </CardContent>
        </Card>

        {/* External - Second on mobile, right on desktop */}
        {(guestMembers.length > 0 || externalMembers.length > 0 || rightColumnBots.length > 0) && (
          <Card variant="muted">
            <CardContent>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">External Members</h2>
                <span className="text-sm text-muted-foreground">
                  {guestMembers.length + externalMembers.length + rightColumnBots.length}{" "}
                  {guestMembers.length + externalMembers.length + rightColumnBots.length === 1
                    ? "user"
                    : "users"}
                </span>
              </div>

              <p className="text-sm text-muted-foreground mb-4">
                The @iterate bot will speak to them like a normal person would.
              </p>
              <p className="text-sm text-muted-foreground mb-4">
                They will not be able to connect to MCP servers, use connectors or access this
                dashboard.
              </p>

              <Accordion
                type="multiple"
                defaultValue={["guests", "slack-connect-users", "slack-connect-bots"]}
              >
                {guestMembers.length > 0 && (
                  <AccordionItem value="guests">
                    <AccordionTrigger>
                      Guests in your Slack ({guestMembers.length})
                    </AccordionTrigger>
                    <AccordionContent>
                      <ItemGroup>
                        {guestMembers.map((member, index) => (
                          <div key={member.id}>
                            <MemberItem member={member} />
                            {index !== guestMembers.length - 1 && <div className="my-2" />}
                          </div>
                        ))}
                      </ItemGroup>
                    </AccordionContent>
                  </AccordionItem>
                )}

                {externalMembers.length > 0 && (
                  <AccordionItem value="slack-connect-users">
                    <AccordionTrigger>
                      Slack Connect Users ({externalMembers.length})
                    </AccordionTrigger>
                    <AccordionContent>
                      <ItemGroup>
                        {externalMembers.map((member, index) => (
                          <div key={member.id}>
                            <MemberItem member={member} />
                            {index !== externalMembers.length - 1 && <div className="my-2" />}
                          </div>
                        ))}
                      </ItemGroup>
                    </AccordionContent>
                  </AccordionItem>
                )}

                {rightColumnBots.length > 0 && (
                  <AccordionItem value="slack-connect-bots">
                    <AccordionTrigger>
                      Slack Connect Bots ({rightColumnBots.length})
                    </AccordionTrigger>
                    <AccordionContent>
                      <ItemGroup>
                        {rightColumnBots.map((bot, index) => (
                          <div key={bot.id}>
                            <MemberItem member={bot} />
                            {index !== rightColumnBots.length - 1 && <div className="my-2" />}
                          </div>
                        ))}
                      </ItemGroup>
                    </AccordionContent>
                  </AccordionItem>
                )}
              </Accordion>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

export default function OrganizationTeam({ params }: Route.ComponentProps) {
  const { organizationId } = params;

  if (!organizationId) {
    return (
      <div className="p-6">
        <div className="text-center text-destructive">Organization ID is required</div>
      </div>
    );
  }

  return <OrganizationTeamContent organizationId={organizationId} />;
}

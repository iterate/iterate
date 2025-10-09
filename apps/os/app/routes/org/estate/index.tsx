import { useState, useMemo } from "react";
import { useNavigate } from "react-router";
import { Bot, Search, ArrowUpDown, Copy, Check, Eye } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Item, ItemContent } from "../../../components/ui/item.tsx";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "../../../components/ui/empty.tsx";
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
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(name);
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
        <span className="sm:hidden">{truncateEnd(name)}</span>
        <span className="hidden sm:inline">{truncateMiddle(name)}</span>
      </button>
      <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={handleCopy}>
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </Button>
    </div>
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

  const { data: agents } = useSuspenseQuery(trpc.agents.list.queryOptions({ estateId }));

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
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

  return (
    <div className="p-6 space-y-6">
      {/* Welcome Section */}
      <Item className="bg-muted/30">
        <ItemContent className="py-8">
          <div className="space-y-4">
            <div className="space-y-2">
              <h1 className="text-3xl font-bold text-foreground">Welcome!</h1>
              <p className="text-lg text-muted-foreground">
                The main way to interact with iterate is by mentioning @iterate in Slack.
              </p>
            </div>
            <Button size="lg" className="text-lg px-8 py-3 h-auto" onClick={openSlackApp}>
              <img src="/slack.svg" alt="Slack" className="h-5 w-5 mr-2" />
              Message @iterate on Slack
            </Button>
          </div>
        </ItemContent>
      </Item>

      {/* Agents Table */}
      <Item>
        <ItemContent>
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
            <div className="rounded-md border">
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
        </ItemContent>
      </Item>
    </div>
  );
}

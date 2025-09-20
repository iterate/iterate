import { useEffect, useRef, useState, useMemo } from "react";
import { useNavigate } from "react-router";
import { Bot, ChevronUp, ChevronDown, Search } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { useSuspenseQuery } from "@tanstack/react-query";
import { DashboardLayout } from "../components/dashboard-layout.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.tsx";
import { useEstateId, useEstateUrl } from "../hooks/use-estate.ts";
import { useTRPC } from "../lib/trpc.ts";

type SortField = "name" | "className" | "createdAt";
type SortDirection = "asc" | "desc";

function AgentInstancesTable() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState("");
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const estateId = useEstateId();
  const getEstateUrl = useEstateUrl();
  const trpc = useTRPC();

  const { data: agents } = useSuspenseQuery(trpc.agents.list.queryOptions({ estateId }));

  const handleRowClick = (params: { agentName: string; className: string }) => {
    const { agentName, className } = params;
    navigate(getEstateUrl(`/agents/${className}/${agentName}`));
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
  };

  const sortedAndFilteredData = useMemo(() => {
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
        case "className":
          aValue = a.className;
          bValue = b.className;
          break;
        case "createdAt":
          aValue = new Date(a.createdAt);
          bValue = new Date(b.createdAt);
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

  if (agents.length === 0) {
    return (
      <div className="text-center py-8">
        <Bot className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <p className="text-muted-foreground">No agent instances found</p>
        <p className="text-sm text-muted-foreground mt-1">
          Create your first agent using the form above
        </p>
      </div>
    );
  }

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) {
      return null;
    }
    return sortDirection === "asc" ? (
      <ChevronUp className="h-4 w-4 ml-1" />
    ) : (
      <ChevronDown className="h-4 w-4 ml-1" />
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Existing Agent Instances</h2>
        <Badge variant="secondary">
          {sortedAndFilteredData.length} of {agents.length} instance{agents.length !== 1 ? "s" : ""}
        </Badge>
      </div>

      {/* Filter bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Filter agents by name..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="pl-10"
        />
      </div>

      <div className="overflow-auto max-h-[calc(100vh-400px)]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead
                className="cursor-pointer hover:bg-muted/50 select-none w-[40%]"
                onClick={() => handleSort("name")}
              >
                <div className="flex items-center">
                  Agent Name
                  {getSortIcon("name")}
                </div>
              </TableHead>
              <TableHead
                className="cursor-pointer hover:bg-muted/50 select-none w-[30%]"
                onClick={() => handleSort("className")}
              >
                <div className="flex items-center">
                  Class Name
                  {getSortIcon("className")}
                </div>
              </TableHead>
              <TableHead
                className="cursor-pointer hover:bg-muted/50 select-none w-[30%]"
                onClick={() => handleSort("createdAt")}
              >
                <div className="flex items-center">
                  Created
                  {getSortIcon("createdAt")}
                </div>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedAndFilteredData.map((agent) => (
              <TableRow
                key={agent.id}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() =>
                  handleRowClick({
                    agentName: agent.durableObjectName,
                    className: agent.className,
                  })
                }
              >
                <TableCell className="font-medium max-w-0 w-[40%]">
                  <div className="truncate pr-2" title={agent.durableObjectName}>
                    {agent.durableObjectName}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground max-w-0 w-[30%]">
                  <div className="truncate pr-2" title={agent.className}>
                    <Badge variant={agent.className === "SlackAgent" ? "default" : "secondary"}>
                      {agent.className}
                    </Badge>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  <div title={format(new Date(agent.createdAt), "PPpp")}>
                    {formatDistanceToNow(new Date(agent.createdAt), { addSuffix: true })}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export default function AgentsIndexPage() {
  const [agentName, setAgentName] = useState<string>("");
  const agentClassName = "IterateAgent"; // Always use IterateAgent
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const getEstateUrl = useEstateUrl();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleNavigate = () => {
    if (agentName.trim() && agentClassName) {
      navigate(getEstateUrl(`/agents/${agentClassName}/${agentName.trim()}`));
    }
  };

  return (
    <DashboardLayout>
      <div className="flex flex-1 flex-col gap-4 p-4 pt-4">
        <Card className="bg-muted/30">
          <CardHeader>
            <CardTitle>Create New Agent</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2 relative">
              <div className="relative flex-1">
                <div className="absolute left-3 top-1/2 transform -translate-y-1/2">
                  <Bot size={16} className="text-muted-foreground" />
                </div>
                <Input
                  id="agent-name"
                  ref={inputRef}
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  placeholder="Enter agent durable object instance name"
                  className="flex-1 pl-10"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleNavigate();
                    }
                  }}
                />
              </div>
              <Button onClick={handleNavigate} disabled={!agentName.trim()}>
                Go
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <AgentInstancesTable />
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}

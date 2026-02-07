import { useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Circle, MailOpen, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc, trpcClient } from "../../lib/trpc.tsx";
import { cn } from "../../lib/utils.ts";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from "../../components/ui/field.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs.tsx";
import { EmptyState } from "../../components/empty-state.tsx";
import { SerializedObjectCodeBlock } from "../../components/serialized-object-code-block.tsx";
import { useQueryInvalidation } from "../../hooks/use-query-invalidation.ts";

type ApprovalStatus = "pending" | "approved" | "rejected" | "timeout";
type Approval = {
  id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
};
type PolicyView = {
  id: string;
  rule: string;
  decision: string;
  priority: number;
  reason: string | null;
};

export const Route = createFileRoute("/_auth/proj/$projectSlug/approvals")({
  component: ProjectApprovalsPage,
});

function ProjectApprovalsPage() {
  const params = useParams({ from: "/_auth/proj/$projectSlug/approvals" });
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<ApprovalStatus | "all">("pending");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [summaryById, setSummaryById] = useState<Record<string, string>>({});
  const [newPolicyRule, setNewPolicyRule] = useState("");
  const [newPolicyDecision, setNewPolicyDecision] = useState<"allow" | "deny" | "human_approval">(
    "human_approval",
  );
  const [newPolicyPriority, setNewPolicyPriority] = useState("100");
  const [newPolicyReason, setNewPolicyReason] = useState("");
  const [rulePrompt, setRulePrompt] = useState("");
  const [editingPolicyId, setEditingPolicyId] = useState<string | null>(null);
  const [summarizingIds, setSummarizingIds] = useState<Set<string>>(new Set());
  const [generatingRuleForIds, setGeneratingRuleForIds] = useState<Set<string>>(new Set());

  const { data: projectWithOrg } = useSuspenseQuery(
    trpc.project.bySlug.queryOptions({ projectSlug: params.projectSlug }),
  );
  const { data: project } = useSuspenseQuery(
    trpc.project.bySlug.queryOptions({ projectSlug: params.projectSlug }),
  );

  useQueryInvalidation(project.organizationId);

  const policiesQueryOptions = trpc.project.listEgressPolicies.queryOptions({
    projectSlug: params.projectSlug,
  });
  const policiesQuery = useSuspenseQuery(policiesQueryOptions);

  const approvalsQueryKey = ["egress-approvals", project.id, filter];
  const { data } = useQuery({
    queryKey: approvalsQueryKey,
    queryFn: async () => {
      const query = new URLSearchParams();
      if (filter !== "all") query.set("status", filter);
      const response = await fetch(`/api/projects/${project.id}/approvals?${query}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch approvals");
      return response.json() as Promise<{ approvals: Approval[] }>;
    },
    enabled: typeof window !== "undefined",
  });
  const approvals = data?.approvals ?? [];

  const approveMutation = useMutation({
    mutationFn: async (approvalId: string) => {
      const response = await fetch(`/api/projects/${project.id}/approvals/${approvalId}/approve`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to approve request");
    },
    onSuccess: () => {
      toast.success("Request approved");
      queryClient.invalidateQueries({ queryKey: approvalsQueryKey });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Failed to approve request"),
  });

  const rejectMutation = useMutation({
    mutationFn: async (approvalId: string) => {
      const response = await fetch(`/api/projects/${project.id}/approvals/${approvalId}/reject`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to reject request");
    },
    onSuccess: () => {
      toast.success("Request rejected");
      queryClient.invalidateQueries({ queryKey: approvalsQueryKey });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Failed to reject request"),
  });

  const summarizeMutation = useMutation({
    mutationFn: async (approvalId: string) => {
      setSummarizingIds((prev) => new Set(prev).add(approvalId));
      const result = await trpcClient.project.summarizeEgressApproval.mutate({
        projectSlug: params.projectSlug,
        approvalId,
      });
      return result.summary;
    },
    onSuccess: (summary, approvalId) => {
      setSummaryById((prev) => ({ ...prev, [approvalId]: summary }));
      setSummarizingIds((prev) => {
        const next = new Set(prev);
        next.delete(approvalId);
        return next;
      });
    },
    onError: (error, approvalId) => {
      setSummarizingIds((prev) => {
        const next = new Set(prev);
        next.delete(approvalId);
        return next;
      });
      toast.error(error instanceof Error ? error.message : "Failed to summarize request");
    },
  });

  const suggestRuleMutation = useMutation({
    mutationFn: async ({
      approvalId,
      instruction,
    }: {
      approvalId?: string;
      instruction: string;
    }) => {
      if (approvalId) setGeneratingRuleForIds((prev) => new Set(prev).add(approvalId));
      const result = await trpcClient.project.suggestEgressRule.mutate({
        projectSlug: params.projectSlug,
        approvalId,
        instruction,
      });
      return result.rule;
    },
    onSuccess: (rule, variables) => {
      setNewPolicyRule(rule);
      if (variables.approvalId) {
        setGeneratingRuleForIds((prev) => {
          const next = new Set(prev);
          next.delete(variables.approvalId!);
          return next;
        });
      }
    },
    onError: (error, variables) => {
      if (variables.approvalId) {
        setGeneratingRuleForIds((prev) => {
          const next = new Set(prev);
          next.delete(variables.approvalId!);
          return next;
        });
      }
      toast.error(error instanceof Error ? error.message : "Failed to generate rule");
    },
  });

  const createPolicyMutation = useMutation({
    mutationFn: async () => {
      const priority = Number(newPolicyPriority || "100");
      return trpcClient.project.createEgressPolicy.mutate({
        projectSlug: params.projectSlug,
        rule: newPolicyRule,
        decision: newPolicyDecision,
        priority: Number.isNaN(priority) ? 100 : priority,
        reason: newPolicyReason || undefined,
      });
    },
    onSuccess: () => {
      toast.success("Policy created");
      setNewPolicyRule("");
      setNewPolicyReason("");
      setNewPolicyPriority("100");
      queryClient.invalidateQueries({
        queryKey: policiesQueryOptions.queryKey as readonly unknown[],
      });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Failed to create policy"),
  });

  const deletePolicyMutation = useMutation({
    mutationFn: async (policyId: string) =>
      trpcClient.project.deleteEgressPolicy.mutate({
        projectSlug: params.projectSlug,
        policyId,
      }),
    onSuccess: (_data, deletedPolicyId) => {
      toast.success("Policy deleted");
      if (editingPolicyId === deletedPolicyId) {
        setEditingPolicyId(null);
        clearPolicyForm();
      }
      queryClient.invalidateQueries({
        queryKey: policiesQueryOptions.queryKey as readonly unknown[],
      });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Failed to delete policy"),
  });

  const updatePolicyMutation = useMutation({
    mutationFn: async () => {
      if (!editingPolicyId) throw new Error("No policy selected");
      const priority = Number(newPolicyPriority || "100");
      return trpcClient.project.updateEgressPolicy.mutate({
        projectSlug: params.projectSlug,
        policyId: editingPolicyId,
        rule: newPolicyRule,
        decision: newPolicyDecision,
        priority: Number.isNaN(priority) ? 100 : priority,
        reason: newPolicyReason || undefined,
      });
    },
    onSuccess: () => {
      toast.success("Policy updated");
      setEditingPolicyId(null);
      clearPolicyForm();
      queryClient.invalidateQueries({
        queryKey: policiesQueryOptions.queryKey as readonly unknown[],
      });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Failed to update policy"),
  });

  const clearPolicyForm = () => {
    setNewPolicyRule("");
    setNewPolicyReason("");
    setNewPolicyPriority("100");
    setNewPolicyDecision("human_approval");
    setRulePrompt("");
  };

  const startEditingPolicy = (policy: PolicyView) => {
    setEditingPolicyId(policy.id);
    setNewPolicyRule(policy.rule);
    setNewPolicyDecision(policy.decision as "allow" | "deny" | "human_approval");
    setNewPolicyPriority(String(policy.priority));
    setNewPolicyReason(policy.reason ?? "");
    setRulePrompt("");
  };

  const policies = (policiesQuery.data ?? []) as PolicyView[];

  return (
    <div className="p-4">
      <Tabs value={filter} onValueChange={(value) => setFilter(value as ApprovalStatus | "all")}>
        <TabsList>
          {FILTERS.map((tab) => (
            <TabsTrigger key={tab} value={tab}>
              {formatFilterLabel(tab)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {approvals.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon={<MailOpen className="h-6 w-6" />}
            title="No approvals yet"
            description="Requests that need review will show up here."
          />
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {approvals.map((approval) => (
            <ApprovalItem
              key={approval.id}
              approval={approval}
              isExpanded={expandedId === approval.id}
              onToggle={() => setExpandedId((cur) => (cur === approval.id ? null : approval.id))}
              summary={summaryById[approval.id]}
              isSummarizing={summarizingIds.has(approval.id)}
              onSummarize={() => summarizeMutation.mutate(approval.id)}
              onApprove={() => approveMutation.mutate(approval.id)}
              onReject={() => rejectMutation.mutate(approval.id)}
              isGeneratingRule={generatingRuleForIds.has(approval.id)}
              onGenerateRule={() =>
                suggestRuleMutation.mutate({
                  approvalId: approval.id,
                  instruction: "Create a rule to match this request",
                })
              }
            />
          ))}
        </div>
      )}

      <PolicyEditor
        policies={policies}
        rule={newPolicyRule}
        decision={newPolicyDecision}
        priority={newPolicyPriority}
        reason={newPolicyReason}
        onRuleChange={setNewPolicyRule}
        onDecisionChange={setNewPolicyDecision}
        onPriorityChange={setNewPolicyPriority}
        onReasonChange={setNewPolicyReason}
        onCreate={() => createPolicyMutation.mutate()}
        isCreating={createPolicyMutation.isPending}
        onDelete={(policyId) => deletePolicyMutation.mutate(policyId)}
        isDeleting={deletePolicyMutation.isPending}
        rulePrompt={rulePrompt}
        onRulePromptChange={setRulePrompt}
        onGenerateRule={() =>
          suggestRuleMutation.mutate({ instruction: rulePrompt || "Create a JSONata rule" })
        }
        isGenerating={suggestRuleMutation.isPending}
        editingPolicyId={editingPolicyId}
        onEdit={startEditingPolicy}
        onUpdate={() => updatePolicyMutation.mutate()}
        isUpdating={updatePolicyMutation.isPending}
        onCancelEdit={() => {
          setEditingPolicyId(null);
          clearPolicyForm();
        }}
      />
    </div>
  );
}

function ApprovalItem({
  approval,
  isExpanded,
  onToggle,
  summary,
  isSummarizing,
  onSummarize,
  onApprove,
  onReject,
  isGeneratingRule,
  onGenerateRule,
}: {
  approval: Approval;
  isExpanded: boolean;
  onToggle: () => void;
  summary?: string;
  isSummarizing: boolean;
  onSummarize: () => void;
  onApprove: () => void;
  onReject: () => void;
  isGeneratingRule: boolean;
  onGenerateRule: () => void;
}) {
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start justify-between gap-4 rounded-lg border bg-card p-4 text-left transition-colors hover:bg-muted/50"
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Circle className={cn("mt-1 h-3 w-3 shrink-0", statusColorClass(approval.status))} />
          <div className="min-w-0 space-y-1">
            <div className="text-sm font-medium">
              <span className="font-mono">{approval.method}</span>{" "}
              <span className="text-muted-foreground">{formatUrl(approval.url)}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              {formatTimestamp(approval.createdAt)} · {approval.status}
            </div>
          </div>
        </div>
        {approval.status === "pending" && (
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                onApprove();
              }}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={(event) => {
                event.stopPropagation();
                onReject();
              }}
            >
              Reject
            </Button>
          </div>
        )}
      </button>
      {isExpanded && (
        <div className="rounded-lg border bg-muted/40 p-4 text-sm">
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase text-muted-foreground">Request</div>
            <SerializedObjectCodeBlock
              data={{
                method: approval.method,
                url: approval.url,
                headers: approval.headers,
                body: approval.body ?? undefined,
              }}
            />
            <SummarySection summary={summary} isLoading={isSummarizing} onGenerate={onSummarize} />
            <Button
              size="sm"
              variant="outline"
              onClick={onGenerateRule}
              disabled={isGeneratingRule}
            >
              {isGeneratingRule ? "Generating..." : "Generate rule from this request"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function SummarySection({
  summary,
  isLoading,
  onGenerate,
}: {
  summary?: string;
  isLoading: boolean;
  onGenerate: () => void;
}) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase text-muted-foreground">Summary</div>
        <Button size="sm" variant="outline" onClick={onGenerate} disabled={isLoading}>
          {isLoading ? "Summarizing..." : summary ? "Regenerate" : "Generate"}
        </Button>
      </div>
      {summary ? (
        <p className="mt-2 text-sm text-foreground">{summary}</p>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Generate a plain-English summary of the request.
        </p>
      )}
    </div>
  );
}

function PolicyEditor({
  policies,
  rule,
  decision,
  priority,
  reason,
  onRuleChange,
  onDecisionChange,
  onPriorityChange,
  onReasonChange,
  onCreate,
  isCreating,
  onDelete,
  isDeleting,
  rulePrompt,
  onRulePromptChange,
  onGenerateRule,
  isGenerating,
  editingPolicyId,
  onEdit,
  onUpdate,
  isUpdating,
  onCancelEdit,
}: {
  policies: PolicyView[];
  rule: string;
  decision: "allow" | "deny" | "human_approval";
  priority: string;
  reason: string;
  onRuleChange: (value: string) => void;
  onDecisionChange: (value: "allow" | "deny" | "human_approval") => void;
  onPriorityChange: (value: string) => void;
  onReasonChange: (value: string) => void;
  onCreate: () => void;
  isCreating: boolean;
  onDelete: (policyId: string) => void;
  isDeleting: boolean;
  rulePrompt: string;
  onRulePromptChange: (value: string) => void;
  onGenerateRule: () => void;
  isGenerating: boolean;
  editingPolicyId: string | null;
  onEdit: (policy: PolicyView) => void;
  onUpdate: () => void;
  isUpdating: boolean;
  onCancelEdit: () => void;
}) {
  return (
    <div className="mt-6 rounded-lg border bg-card p-4">
      <FieldSet>
        <FieldLegend>Egress rules</FieldLegend>
        <FieldGroup>
          <Field>
            <FieldLabel>Describe the rule (AI will generate JSONata)</FieldLabel>
            <div className="flex gap-2">
              <Input
                value={rulePrompt}
                onChange={(event) => onRulePromptChange(event.target.value)}
                placeholder="e.g. allow all requests to gmail.googleapis.com"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && rulePrompt.trim()) {
                    event.preventDefault();
                    onGenerateRule();
                  }
                }}
              />
              <Button
                variant="outline"
                onClick={onGenerateRule}
                disabled={isGenerating || !rulePrompt.trim()}
              >
                {isGenerating ? "..." : "Generate"}
              </Button>
            </div>
          </Field>
          <Field>
            <FieldLabel>Rule (JSONata)</FieldLabel>
            <Textarea
              value={rule}
              onChange={(event) => onRuleChange(event.target.value)}
              placeholder="url.hostname = 'gmail.googleapis.com'"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field>
              <FieldLabel>Decision</FieldLabel>
              <Select
                value={decision}
                onValueChange={(value) => onDecisionChange(value as typeof decision)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select decision" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="allow">Allow</SelectItem>
                  <SelectItem value="deny">Deny</SelectItem>
                  <SelectItem value="human_approval">Human approval</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Priority</FieldLabel>
              <Input
                value={priority}
                onChange={(event) => onPriorityChange(event.target.value)}
                inputMode="numeric"
              />
            </Field>
            <Field>
              <FieldLabel>Reason (optional)</FieldLabel>
              <Input value={reason} onChange={(event) => onReasonChange(event.target.value)} />
            </Field>
          </div>
          <Field orientation="horizontal">
            {editingPolicyId ? (
              <>
                <Button onClick={onUpdate} disabled={isUpdating || rule.trim().length === 0}>
                  {isUpdating ? "Updating..." : "Update rule"}
                </Button>
                <Button variant="outline" onClick={onCancelEdit}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button onClick={onCreate} disabled={isCreating || rule.trim().length === 0}>
                {isCreating ? "Creating..." : "Create rule"}
              </Button>
            )}
          </Field>
        </FieldGroup>
      </FieldSet>
      {policies.length > 0 && (
        <div className="mt-4 space-y-2 text-sm">
          {policies.map((policy) => (
            <button
              key={policy.id}
              type="button"
              onClick={() => onEdit(policy)}
              className={cn(
                "w-full rounded border bg-background p-3 text-left transition-colors hover:bg-muted/50",
                editingPolicyId === policy.id && "ring-2 ring-primary",
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-muted-foreground">
                  {policy.decision} · priority {policy.priority}
                  {policy.reason && <span> · {policy.reason}</span>}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(policy.id);
                  }}
                  disabled={isDeleting}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <SerializedObjectCodeBlock className="mt-2" data={{ rule: policy.rule }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const FILTERS: Array<ApprovalStatus | "all"> = [
  "pending",
  "approved",
  "rejected",
  "timeout",
  "all",
];
function formatFilterLabel(value: ApprovalStatus | "all") {
  return value === "all" ? "All" : value.charAt(0).toUpperCase() + value.slice(1);
}
function formatUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}
function formatTimestamp(value: string) {
  return new Date(value).toLocaleString();
}
function statusColorClass(status: ApprovalStatus) {
  switch (status) {
    case "pending":
      return "text-yellow-500 fill-yellow-500";
    case "approved":
      return "text-emerald-500 fill-emerald-500";
    case "rejected":
      return "text-rose-500 fill-rose-500";
    case "timeout":
      return "text-muted-foreground fill-muted-foreground";
    default:
      return "text-muted-foreground fill-muted-foreground";
  }
}

import { useState, type FormEvent } from "react";
import { createFileRoute, useParams, Link } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  SlidersHorizontal,
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Lock,
  Github,
  MessageSquare,
  Mail,
} from "lucide-react";
import { toast } from "sonner";
import { z } from "zod/v4";
import { trpc, trpcClient } from "../../../lib/trpc.tsx";
import { EmptyState } from "../../../components/empty-state.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Input } from "../../../components/ui/input.tsx";
import { Textarea } from "../../../components/ui/textarea.tsx";
import { Checkbox } from "../../../components/ui/checkbox.tsx";
import { Label } from "../../../components/ui/label.tsx";
import { HeaderActions } from "../../../components/header-actions.tsx";
import { ConfirmDialog } from "../../../components/ui/confirm-dialog.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../../../components/ui/sheet.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu.tsx";
import { Alert, AlertDescription } from "../../../components/ui/alert.tsx";
import { getSecretHint } from "../../../lib/secret-hint.ts";

const Search = z.object({
  add: z.boolean().optional(),
});

export const Route = createFileRoute(
  "/_auth/orgs/$organizationSlug/projects/$projectSlug/env-vars",
)({
  validateSearch: Search,
  component: ProjectEnvVarsPage,
});

type EnvVarSource =
  | { type: "global"; description: string }
  | { type: "connection"; provider: "github" | "slack" | "google" }
  | { type: "user"; envVarId: string }
  | { type: "recommended"; provider: "google"; userEmail: string };

type ParsedSecret = {
  secretKey: string;
  secretScope: string;
  machineId?: string;
  userId?: string;
  userEmail?: string;
};

type EnvVar = {
  key: string;
  value: string;
  secret: ParsedSecret | null;
  description: string | null;
  egressProxyRule: string | null;
  source: EnvVarSource;
  createdAt: Date | null;
};

function ProjectEnvVarsPage() {
  const params = useParams({
    from: "/_auth/orgs/$organizationSlug/projects/$projectSlug/env-vars",
  });
  const queryClient = useQueryClient();

  // Sheet state
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const [editingEnvVar, setEditingEnvVar] = useState<EnvVar | null>(null);
  const [deleteConfirmEnvVar, setDeleteConfirmEnvVar] = useState<EnvVar | null>(null);

  // Info dialogs for non-editable sources
  const [infoDialogEnvVar, setInfoDialogEnvVar] = useState<EnvVar | null>(null);

  // Form state
  const [formKey, setFormKey] = useState("");
  const [formValue, setFormValue] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formIsSecret, setFormIsSecret] = useState(false);
  const [secretHintDismissed, setSecretHintDismissed] = useState(false);

  const envVarListOptions = trpc.envVar.list.queryOptions({
    organizationSlug: params.organizationSlug,
    projectSlug: params.projectSlug,
  });

  const { data: allEnvVars } = useSuspenseQuery(envVarListOptions);

  // Split into active env vars and recommended (user-scoped secrets)
  const envVars = allEnvVars.filter((v) => v.source.type !== "recommended");
  const recommendedEnvVars = allEnvVars.filter((v) => v.source.type === "recommended");

  // Derive which connectors are connected from env var sources or secret scopes
  const connectorScopes = new Set(["google", "github", "slack"]);
  const connectedProviders = new Set(
    allEnvVars.flatMap((v) => [
      ...("provider" in v.source ? [v.source.provider] : []),
      ...(v.secret && connectorScopes.has(v.secret.secretScope) ? [v.secret.secretScope] : []),
    ]),
  );

  const connectorSuggestions = [
    { provider: "github", label: "GitHub", icon: Github },
    { provider: "slack", label: "Slack", icon: MessageSquare },
    { provider: "google", label: "Google", icon: Mail },
  ];
  const missingConnectors = connectorSuggestions.filter((c) => !connectedProviders.has(c.provider));

  // Find which keys are overridden (appear multiple times, later one wins)
  const overriddenKeys = new Set<string>();
  const seenKeys = new Map<string, number>();
  envVars.forEach((v, idx) => {
    if (seenKeys.has(v.key)) {
      overriddenKeys.add(v.key);
    }
    seenKeys.set(v.key, idx);
  });

  // Which specific entries are overridden (not the overriding ones)
  const isOverridden = (envVar: EnvVar, idx: number) => {
    if (!overriddenKeys.has(envVar.key)) return false;
    const lastIdx = seenKeys.get(envVar.key);
    return idx !== lastIdx;
  };

  const setEnvVar = useMutation({
    mutationFn: async (input: { key: string; value: string; description?: string }) => {
      return trpcClient.envVar.set.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        key: input.key,
        value: input.value,
        description: input.description,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: envVarListOptions.queryKey });
      resetForm();
      setAddSheetOpen(false);
      setEditingEnvVar(null);
      toast.success("Environment variable saved!");
    },
    onError: (error) => {
      toast.error("Failed to save: " + error.message);
    },
  });

  const createSecret = useMutation({
    mutationFn: async (input: { key: string; value: string }) => {
      return trpcClient.secret.create.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        key: input.key,
        value: input.value,
      });
    },
  });

  const updateSecret = useMutation({
    mutationFn: async (input: { key: string; value: string }) => {
      return trpcClient.secret.updateByKey.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        key: input.key,
        value: input.value,
      });
    },
  });

  const deleteEnvVar = useMutation({
    mutationFn: async (key: string) => {
      return trpcClient.envVar.delete.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        key,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: envVarListOptions.queryKey });
      setDeleteConfirmEnvVar(null);
      toast.success("Environment variable deleted!");
    },
    onError: (error) => {
      toast.error("Failed to delete: " + error.message);
    },
  });

  const resetForm = () => {
    setFormKey("");
    setFormValue("");
    setFormDescription("");
    setFormIsSecret(false);
    setSecretHintDismissed(false);
  };

  const handleOpenAdd = () => {
    resetForm();
    setEditingEnvVar(null);
    setAddSheetOpen(true);
  };

  const handleOpenEdit = (envVar: EnvVar) => {
    if (envVar.source.type === "global" || envVar.source.type === "connection") {
      setInfoDialogEnvVar(envVar);
      return;
    }
    // User-defined - open edit sheet
    setFormKey(envVar.key);
    // If it's a secret, don't show the magic string - show empty for new value entry
    setFormValue(envVar.secret ? "" : envVar.value);
    setFormDescription(envVar.description ?? "");
    setFormIsSecret(!!envVar.secret);
    setEditingEnvVar(envVar);
    setAddSheetOpen(true);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const key = formKey.trim();
    const value = formValue.trim();
    const description = formDescription.trim() || undefined;
    if (!key || !value) return;

    // Check if this key will override an existing one
    const existingNonUser = envVars.find((v) => v.key === key && v.source.type !== "user");
    if (existingNonUser && !editingEnvVar) {
      // Show info toast but continue
      toast.info(
        `This will override the ${existingNonUser.source.type === "global" ? "global" : existingNonUser.source.type === "connection" ? (existingNonUser.source as { type: "connection"; provider: string }).provider : ""} env var "${key}"`,
      );
    }

    if (formIsSecret) {
      // Create/update secret, then env var with magic string
      const secretKey = `env.${key}`;
      try {
        if (editingEnvVar) {
          // Update existing secret
          await updateSecret.mutateAsync({ key: secretKey, value });
        } else {
          await createSecret.mutateAsync({ key: secretKey, value });
        }
        const magicValue = `getIterateSecret({secretKey: '${secretKey}'})`;
        await setEnvVar.mutateAsync({ key, value: magicValue, description });
      } catch (error) {
        // If secret already exists, try updating it
        if (error instanceof Error && error.message.includes("already exists")) {
          try {
            await updateSecret.mutateAsync({ key: secretKey, value });
            const magicValue = `getIterateSecret({secretKey: '${secretKey}'})`;
            await setEnvVar.mutateAsync({ key, value: magicValue, description });
          } catch {
            toast.error("Failed to update secret");
          }
        } else {
          toast.error(
            "Failed to create secret: " +
              (error instanceof Error ? error.message : "Unknown error"),
          );
        }
      }
    } else {
      setEnvVar.mutate({ key, value, description });
    }
  };

  const getSourceLabel = (source: EnvVarSource): string => {
    switch (source.type) {
      case "global":
        return "Global";
      case "connection":
        return `${source.provider.charAt(0).toUpperCase() + source.provider.slice(1)} connection`;
      case "user":
        return "Custom";
      case "recommended":
        return `${source.provider.charAt(0).toUpperCase() + source.provider.slice(1)} (recommended)`;
    }
  };

  const isPending = setEnvVar.isPending || createSecret.isPending;

  const addSheet = (
    <Sheet open={addSheetOpen} onOpenChange={setAddSheetOpen}>
      <SheetContent>
        <form onSubmit={handleSubmit} className="flex flex-col h-full">
          <SheetHeader>
            <SheetTitle>
              {editingEnvVar ? "Edit Environment Variable" : "Add Environment Variable"}
            </SheetTitle>
            <SheetDescription>
              {editingEnvVar
                ? "Update this environment variable."
                : "Add a new environment variable to your project."}
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 space-y-4 p-4">
            <div className="space-y-2">
              <Label htmlFor="env-key">Key</Label>
              <Input
                id="env-key"
                value={formKey}
                onChange={(e) => setFormKey(e.target.value.toUpperCase())}
                placeholder="MY_API_KEY"
                disabled={isPending || !!editingEnvVar}
                pattern="[A-Z_][A-Z0-9_]*"
                title="Uppercase letters, numbers, and underscores"
                autoFocus={!editingEnvVar}
                autoComplete="off"
                data-1p-ignore
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="env-value">Value</Label>
              <Textarea
                id="env-value"
                value={formValue}
                onChange={(e) => setFormValue(e.target.value)}
                placeholder="Enter the value"
                disabled={isPending}
                rows={4}
                className="font-mono text-sm"
                autoFocus={!!editingEnvVar}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="env-description">Description (optional)</Label>
              <Input
                id="env-description"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="What this env var is used for"
                disabled={isPending}
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="is-secret"
                checked={formIsSecret}
                onCheckedChange={(checked) => setFormIsSecret(checked === true)}
                disabled={isPending || !!editingEnvVar?.secret}
              />
              <Label
                htmlFor="is-secret"
                className={`text-sm font-normal ${editingEnvVar?.secret ? "" : "cursor-pointer"}`}
              >
                Store as secret (encrypted, accessed via egress proxy)
              </Label>
            </div>
            {formIsSecret ? (
              <Alert>
                <Lock className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  {editingEnvVar ? (
                    "Enter a new value to update the encrypted secret."
                  ) : (
                    <>
                      The value will be stored encrypted. The env var will be set to{" "}
                      <code className="bg-muted px-1 rounded">
                        getIterateSecret({`{secretKey: 'env.${formKey || "YOUR_KEY"}'}`})
                      </code>
                    </>
                  )}
                </AlertDescription>
              </Alert>
            ) : (
              <SecretHintAlert
                formKey={formKey}
                formValue={formValue}
                dismissed={secretHintDismissed}
                onDismiss={() => setSecretHintDismissed(true)}
              />
            )}
          </div>
          <SheetFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setAddSheetOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                !formKey.trim() ||
                !formValue.trim() ||
                isPending ||
                hasBlockingSecretHint(formKey, formValue, formIsSecret, secretHintDismissed)
              }
            >
              {isPending ? "Saving..." : editingEnvVar ? "Update" : "Add"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );

  const infoDialogContent = infoDialogEnvVar && (
    <Dialog open={!!infoDialogEnvVar} onOpenChange={() => setInfoDialogEnvVar(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {infoDialogEnvVar.source.type === "global"
              ? "Global Environment Variable"
              : "Connection Environment Variable"}
          </DialogTitle>
          <DialogDescription>
            {infoDialogEnvVar.source.type === "global"
              ? "This is a global env var provided by Iterate and can't be edited or removed. You can override it by adding another env var with the same name."
              : `This env var comes from your ${(infoDialogEnvVar.source as { type: "connection"; provider: string }).provider} connection. You can remove it by disconnecting, or override it by adding another env var with the same name.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-4">
          <div>
            <div className="text-sm font-medium mb-1">Name</div>
            <code className="text-sm">{infoDialogEnvVar.key}</code>
          </div>
          <div>
            <div className="text-sm font-medium mb-1">Value</div>
            <code className="text-sm text-muted-foreground break-all">
              {infoDialogEnvVar.value}
            </code>
          </div>
          {infoDialogEnvVar.egressProxyRule && (
            <div>
              <div className="text-sm font-medium mb-1">Egress Proxy Rule</div>
              <code className="text-sm text-muted-foreground">
                {infoDialogEnvVar.egressProxyRule}
              </code>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setInfoDialogEnvVar(null)}>
            Close
          </Button>
          <Button
            onClick={() => {
              setFormKey(infoDialogEnvVar.key);
              setFormValue("");
              setFormIsSecret(false);
              setEditingEnvVar(null);
              setAddSheetOpen(true);
              setInfoDialogEnvVar(null);
            }}
          >
            Override with custom value
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );

  if (envVars.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        {addSheet}
        <EmptyState
          icon={<SlidersHorizontal className="h-12 w-12" />}
          title="No environment variables"
          description="Environment variables will be available to your machines."
          action={
            <Button onClick={handleOpenAdd}>
              <Plus className="h-4 w-4" />
              Add Environment Variable
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="p-4">
      <HeaderActions>
        <Button size="sm" onClick={handleOpenAdd}>
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">Add Environment Variable</span>
        </Button>
      </HeaderActions>

      {addSheet}
      {infoDialogContent}

      <ConfirmDialog
        open={!!deleteConfirmEnvVar}
        onOpenChange={(open) => !open && setDeleteConfirmEnvVar(null)}
        title="Delete environment variable?"
        description={
          deleteConfirmEnvVar
            ? isSecretWithCustomKey(deleteConfirmEnvVar)
              ? `This will permanently delete "${deleteConfirmEnvVar.key}" and its stored secret. This action cannot be undone.`
              : `This will delete "${deleteConfirmEnvVar.key}".`
            : ""
        }
        confirmLabel="Delete"
        onConfirm={() => deleteConfirmEnvVar && deleteEnvVar.mutate(deleteConfirmEnvVar.key)}
        destructive
      />

      {/* Explainer */}
      <p className="text-sm text-muted-foreground mb-4">
        Environment variables are available to your machines. Secret values use{" "}
        <code className="text-xs bg-muted px-1 rounded">getIterateSecret(...)</code> which the
        egress proxy resolves at request time, so secrets are not visible to our agent.
      </p>

      {/* Missing connectors */}
      {missingConnectors.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {missingConnectors.map(({ provider, label, icon: Icon }) => (
            <Link
              key={provider}
              to="/orgs/$organizationSlug/projects/$projectSlug/connectors"
              params={{
                organizationSlug: params.organizationSlug,
                projectSlug: params.projectSlug,
              }}
            >
              <Button variant="outline" size="sm">
                <Icon className="h-4 w-4" />
                Add {label} Access
              </Button>
            </Link>
          ))}
        </div>
      )}

      {/* Table-like layout */}
      <div className="border rounded-lg divide-y">
        {envVars.map((envVar, idx) => {
          const overridden = isOverridden(envVar, idx);
          const isUserDefined = envVar.source.type === "user";
          const isNonEditable = !isUserDefined;

          return (
            <div
              key={`${envVar.key}-${idx}`}
              className={`flex items-center px-4 py-3 gap-4 ${isNonEditable ? "opacity-70" : ""}`}
            >
              {/* Left content */}
              <div className="flex-1 min-w-0">
                {/* Top row: name | value */}
                <div className="flex items-center gap-4">
                  {/* Name column - fixed width */}
                  <span
                    className={`w-56 shrink-0 font-mono text-sm truncate ${overridden ? "text-muted-foreground" : ""}`}
                    style={overridden ? { textDecoration: "line-through" } : undefined}
                    title={envVar.key}
                  >
                    {envVar.key}
                  </span>

                  {/* Value column - takes remaining space */}
                  <span
                    className="flex-1 min-w-0 font-mono text-sm text-muted-foreground truncate"
                    style={overridden ? { textDecoration: "line-through" } : undefined}
                    title={envVar.value}
                  >
                    {envVar.value}
                  </span>
                </div>

                {/* Second row: source info */}
                <div className="flex items-center gap-4 mt-0.5">
                  <div className="w-56 shrink-0 text-xs text-muted-foreground flex items-center gap-1">
                    {envVar.secret && <Lock className="h-3 w-3" />}
                    <span>{getSourceLabel(envVar.source)}</span>
                  </div>
                  {envVar.description && (
                    <div className="flex-1 min-w-0 text-xs text-muted-foreground truncate">
                      {envVar.description}
                    </div>
                  )}
                </div>
              </div>

              {/* Menu button - vertically centered */}
              {isUserDefined ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="shrink-0 h-8 w-8">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => handleOpenEdit(envVar)}>
                      <Pencil className="h-4 w-4 mr-2" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => setDeleteConfirmEnvVar(envVar)}
                      className="text-destructive"
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 h-8 w-8"
                  onClick={() => handleOpenEdit(envVar)}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {/* Recommended env vars (user-scoped secrets like Google) */}
      {recommendedEnvVars.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium mb-2">Recommended</h3>
          <p className="text-sm text-muted-foreground mb-3">
            These env vars are available from your connected accounts. Add them to make them
            accessible to your machines.
          </p>
          <div className="border rounded-lg divide-y">
            {recommendedEnvVars.map((rec) => (
              <div key={rec.key} className="flex items-center px-4 py-3 gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-4">
                    <span className="w-56 shrink-0 font-mono text-sm truncate" title={rec.key}>
                      {rec.key}
                    </span>
                    <span
                      className="flex-1 min-w-0 font-mono text-sm text-muted-foreground truncate"
                      title={rec.value}
                    >
                      {rec.value}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 mt-0.5">
                    <div className="w-56 shrink-0 text-xs text-muted-foreground flex items-center gap-1">
                      <Lock className="h-3 w-3" />
                      <span>
                        {rec.source.type === "recommended" &&
                          rec.source.provider.charAt(0).toUpperCase() +
                            rec.source.provider.slice(1)}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0 text-xs text-muted-foreground truncate">
                      {rec.description}
                    </div>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setEnvVar.mutate({
                      key: rec.key,
                      value: rec.value,
                      description: rec.description ?? undefined,
                    })
                  }
                  disabled={setEnvVar.isPending}
                >
                  <Plus className="h-4 w-4" />
                  Add
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Shows a hint when the value looks like it should be a secret */
function SecretHintAlert({
  formKey,
  formValue,
  dismissed,
  onDismiss,
}: {
  formKey: string;
  formValue: string;
  dismissed: boolean;
  onDismiss: () => void;
}) {
  const hint = getSecretHint(formKey, formValue);
  if (!hint.looksLikeSecret || dismissed) return null;

  const messages: Record<NonNullable<typeof hint.reason>, string> = {
    "key-name": "The key name suggests this might be a secret.",
    "value-pattern": "The value looks like an API key or token.",
    "high-entropy": "The value has high entropy (looks random).",
  };

  return (
    <Alert variant="destructive">
      <Lock className="h-4 w-4" />
      <AlertDescription className="text-xs flex items-center justify-between gap-2">
        <span>{messages[hint.reason!]} Check "Store as secret" or dismiss this warning.</span>
        <Button variant="outline" size="sm" className="h-6 text-xs shrink-0" onClick={onDismiss}>
          Dismiss
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** Check if the secret hint warning is blocking submission */
function hasBlockingSecretHint(
  formKey: string,
  formValue: string,
  formIsSecret: boolean,
  dismissed: boolean,
): boolean {
  if (formIsSecret || dismissed) return false;
  const hint = getSecretHint(formKey, formValue);
  return hint.looksLikeSecret;
}

/**
 * Check if an env var is a user-created secret (env.* key).
 * Deleting these is permanent because the secret is also deleted.
 */
function isSecretWithCustomKey(envVar: EnvVar): boolean {
  return envVar.secret?.secretScope === "env";
}

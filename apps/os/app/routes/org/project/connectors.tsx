import { useState, useEffect, type FormEvent } from "react";
import { createFileRoute, useParams, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Mail,
  MessageSquare,
  ExternalLink,
  Github,
  SlidersHorizontal,
  Trash2,
  Globe,
  Server,
  KeyRound,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import { z } from "zod/v4";
import { Button } from "../../../components/ui/button.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { Spinner } from "../../../components/ui/spinner.tsx";
import {
  Item,
  ItemMedia,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
  ItemGroup,
} from "../../../components/ui/item.tsx";
import { trpc, trpcClient } from "../../../lib/trpc.tsx";
import { EmptyState } from "../../../components/empty-state.tsx";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldDescription,
} from "../../../components/ui/field.tsx";
import { Input } from "../../../components/ui/input.tsx";
import { Textarea } from "../../../components/ui/textarea.tsx";
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

const Search = z.object({
  error: z.string().optional(),
});

export const Route = createFileRoute(
  "/_auth/orgs/$organizationSlug/projects/$projectSlug/connectors",
)({
  validateSearch: Search,
  component: ProjectConnectorsPage,
});

function ProjectConnectorsPage() {
  const params = useParams({
    from: "/_auth/orgs/$organizationSlug/projects/$projectSlug/connectors",
  });
  const search = useSearch({
    from: "/_auth/orgs/$organizationSlug/projects/$projectSlug/connectors",
  });
  const queryClient = useQueryClient();

  useEffect(() => {
    if (search.error === "slack_oauth_denied") {
      toast.error("Slack authorization was denied.");
    } else if (search.error === "google_oauth_denied") {
      toast.error("Google authorization was denied.");
    } else if (search.error === "github_oauth_denied") {
      toast.error("GitHub authorization was denied.");
    }
  }, [search.error]);

  const { data: slackConnection } = useSuspenseQuery(
    trpc.project.getSlackConnection.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
    }),
  );

  const { data: googleConnection } = useSuspenseQuery(
    trpc.project.getGoogleConnection.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
    }),
  );

  const { data: githubConnection } = useSuspenseQuery(
    trpc.project.getGithubConnection.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
    }),
  );

  const { data: secrets } = useSuspenseQuery(
    trpc.project.listSecrets.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
    }),
  );

  const { data: envVars } = useSuspenseQuery(
    trpc.envVar.list.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
    }),
  );

  const { data: machines } = useSuspenseQuery(
    trpc.machine.list.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
      includeArchived: false,
    }),
  );

  const startSlackOAuth = useMutation({
    mutationFn: () =>
      trpcClient.project.startSlackOAuthFlow.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
      }),
    onSuccess: (data) => {
      window.location.href = data.authorizationUrl;
    },
    onError: (error) => {
      toast.error(`Failed to start Slack connection: ${error.message}`);
    },
  });

  const disconnectSlack = useMutation({
    mutationFn: () =>
      trpcClient.project.disconnectSlack.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
      }),
    onSuccess: () => {
      toast.success("Slack disconnected");
      queryClient.invalidateQueries({
        queryKey: trpc.project.getSlackConnection.queryKey({
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
        }),
      });
    },
    onError: (error) => {
      toast.error(`Failed to disconnect Slack: ${error.message}`);
    },
  });

  const startGoogleOAuth = useMutation({
    mutationFn: () =>
      trpcClient.project.startGoogleOAuthFlow.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
      }),
    onSuccess: (data) => {
      window.location.href = data.authorizationUrl;
    },
    onError: (error) => {
      toast.error(`Failed to start Google connection: ${error.message}`);
    },
  });

  const disconnectGoogle = useMutation({
    mutationFn: () =>
      trpcClient.project.disconnectGoogle.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
      }),
    onSuccess: () => {
      toast.success("Google disconnected");
      queryClient.invalidateQueries({
        queryKey: trpc.project.getGoogleConnection.queryKey({
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
        }),
      });
    },
    onError: (error) => {
      toast.error(`Failed to disconnect Google: ${error.message}`);
    },
  });

  const startGithubInstall = useMutation({
    mutationFn: () =>
      trpcClient.project.startGithubInstallFlow.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
      }),
    onSuccess: (data) => {
      window.location.href = data.installationUrl;
    },
    onError: (error) => {
      toast.error(`Failed to start GitHub install: ${error.message}`);
    },
  });

  const disconnectGithub = useMutation({
    mutationFn: () =>
      trpcClient.project.disconnectGithub.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
      }),
    onSuccess: () => {
      toast.success("GitHub disconnected");
      queryClient.invalidateQueries({
        queryKey: trpc.project.getGithubConnection.queryKey({
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
        }),
      });
    },
    onError: (error) => {
      toast.error(`Failed to disconnect GitHub: ${error.message}`);
    },
  });

  const globalEnvVars = envVars.filter((v) => !v.machineId);
  const machineEnvVarsMap = new Map<string, typeof envVars>();
  for (const v of envVars) {
    if (v.machineId) {
      const existing = machineEnvVarsMap.get(v.machineId) ?? [];
      existing.push(v);
      machineEnvVarsMap.set(v.machineId, existing);
    }
  }

  const getMachineName = (machineId: string) => {
    const machine = machines.find((m) => m.id === machineId);
    return machine?.name ?? machineId;
  };

  return (
    <div className="p-4 space-y-8">
      {/* Connectors Section */}
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Connectors</h2>
          <p className="text-sm text-muted-foreground">
            External services connected to this project.
          </p>
        </div>

        <ItemGroup className="space-y-3">
          {/* Slack Connection */}
          <Item variant="outline">
            <ItemMedia variant="icon">
              <MessageSquare className="h-4 w-4" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                Slack
                {slackConnection.connected && (
                  <Badge variant="secondary" className="ml-2">
                    Connected
                  </Badge>
                )}
              </ItemTitle>
              <ItemDescription>
                {slackConnection.connected && slackConnection.teamName ? (
                  <span className="flex items-center gap-2">
                    Connected to{" "}
                    <span className="font-medium text-foreground">{slackConnection.teamName}</span>
                    {slackConnection.teamDomain && (
                      <a
                        href={`https://${slackConnection.teamDomain}.slack.com`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </span>
                ) : (
                  "Receive messages and run commands from Slack."
                )}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {slackConnection.connected ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => disconnectSlack.mutate()}
                  disabled={disconnectSlack.isPending}
                  className="text-destructive border-destructive/50 hover:bg-destructive/10 hover:text-destructive"
                >
                  {disconnectSlack.isPending && <Spinner className="mr-2" />}
                  Disconnect
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => startSlackOAuth.mutate()}
                  disabled={startSlackOAuth.isPending}
                >
                  {startSlackOAuth.isPending && <Spinner className="mr-2" />}
                  Add to Slack
                </Button>
              )}
            </ItemActions>
          </Item>

          {/* GitHub Connection */}
          <Item variant="outline">
            <ItemMedia variant="icon">
              <Github className="h-4 w-4" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                GitHub
                {githubConnection.connected && (
                  <Badge variant="secondary" className="ml-2">
                    Connected
                  </Badge>
                )}
              </ItemTitle>
              <ItemDescription>
                {githubConnection.connected
                  ? "Connect repositories for code integration."
                  : "Install GitHub App to connect repositories."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {githubConnection.connected ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => disconnectGithub.mutate()}
                  disabled={disconnectGithub.isPending}
                  className="text-destructive border-destructive/50 hover:bg-destructive/10 hover:text-destructive"
                >
                  {disconnectGithub.isPending && <Spinner className="mr-2" />}
                  Disconnect
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => startGithubInstall.mutate()}
                  disabled={startGithubInstall.isPending}
                >
                  {startGithubInstall.isPending && <Spinner className="mr-2" />}
                  Connect GitHub
                </Button>
              )}
            </ItemActions>
          </Item>

          {/* Google Connection */}
          <Item variant="outline">
            <ItemMedia variant="icon">
              <Mail className="h-4 w-4" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                Google
                {googleConnection.connected && (
                  <Badge variant="secondary" className="ml-2">
                    Connected
                  </Badge>
                )}
              </ItemTitle>
              <ItemDescription>
                {googleConnection.connected && googleConnection.email ? (
                  <span className="flex items-center gap-2">
                    Connected as{" "}
                    <span className="font-medium text-foreground">{googleConnection.email}</span>
                  </span>
                ) : (
                  "Gmail, Calendar, Docs, Sheets, and Drive access for your account."
                )}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {googleConnection.connected ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => disconnectGoogle.mutate()}
                  disabled={disconnectGoogle.isPending}
                  className="text-destructive border-destructive/50 hover:bg-destructive/10 hover:text-destructive"
                >
                  {disconnectGoogle.isPending && <Spinner className="mr-2" />}
                  Disconnect
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => startGoogleOAuth.mutate()}
                  disabled={startGoogleOAuth.isPending}
                >
                  {startGoogleOAuth.isPending && <Spinner className="mr-2" />}
                  Connect Google
                </Button>
              )}
            </ItemActions>
          </Item>
        </ItemGroup>
      </section>

      {/* Secrets Section */}
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Secrets</h2>
          <p className="text-sm text-muted-foreground">
            Encrypted secrets from connected services. Use these to create environment variables.
          </p>
        </div>

        {secrets.length > 0 ? (
          <ItemGroup className="space-y-3">
            {secrets.map((secret) => (
              <SecretItem key={secret.id} secret={secret} params={params} machines={machines} />
            ))}
          </ItemGroup>
        ) : (
          <EmptyState
            icon={<KeyRound className="h-12 w-12" />}
            title="No secrets"
            description="Connect services above to create secrets automatically."
          />
        )}
      </section>

      {/* Environment Variables Section */}
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Environment Variables</h2>
          <p className="text-sm text-muted-foreground">
            Configure environment variables for your machines.
          </p>
        </div>

        <EnvVarForm params={params} machines={machines} />

        {envVars.length > 0 ? (
          <div className="space-y-8">
            {globalEnvVars.length > 0 && (
              <EnvVarSection
                title="Global"
                icon={<Globe className="h-4 w-4" />}
                envVars={globalEnvVars}
                params={params}
              />
            )}

            {Array.from(machineEnvVarsMap.entries()).map(([machineId, vars]) => (
              <EnvVarSection
                key={machineId}
                title={getMachineName(machineId)}
                icon={<Server className="h-4 w-4" />}
                envVars={vars}
                params={params}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<SlidersHorizontal className="h-12 w-12" />}
            title="No environment variables"
            description="Store project secrets and configuration here."
          />
        )}
      </section>
    </div>
  );
}

function SecretItem({
  secret,
  params,
  machines,
}: {
  secret: {
    id: string;
    key: string;
    scope: "user" | "project";
    userEmail: string | null;
    lastSuccessAt: Date | null;
    lastFailedAt: Date | null;
    createdAt: Date;
  };
  params: { organizationSlug: string; projectSlug: string };
  machines: Array<{ id: string; name: string }>;
}) {
  const [isCreatingEnvVar, setIsCreatingEnvVar] = useState(false);
  const [selectedMachineId, setSelectedMachineId] = useState<string | undefined>(undefined);
  const queryClient = useQueryClient();

  // Generate recommended env var name from secret key
  // e.g. "google.access_token" -> "GOOGLE_ACCESS_TOKEN"
  const recommendedEnvVarName = secret.key.toUpperCase().replace(/\./g, "_");

  const setEnvVar = useMutation({
    mutationFn: async (input: { key: string; value: string; machineId?: string }) => {
      return trpcClient.envVar.set.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        key: input.key,
        value: input.value,
        machineId: input.machineId,
      });
    },
    onSuccess: () => {
      toast.success("Environment variable created!");
      setIsCreatingEnvVar(false);
      queryClient.invalidateQueries({
        queryKey: trpc.envVar.list.queryKey({
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
        }),
      });
    },
    onError: (error) => {
      toast.error("Failed to create environment variable: " + error.message);
    },
  });

  const handleCreateEnvVar = () => {
    const magicString = secret.userEmail
      ? `getIterateSecret({secretKey: "${secret.key}", userEmail: "${secret.userEmail}"})`
      : `getIterateSecret({secretKey: "${secret.key}"})`;

    setEnvVar.mutate({
      key: recommendedEnvVarName,
      value: magicString,
      machineId: selectedMachineId,
    });
  };

  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <KeyRound className="h-4 w-4" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          <span className="font-mono text-sm">{secret.key}</span>
          <Badge variant="outline" className="ml-2 text-xs">
            {secret.scope}
          </Badge>
        </ItemTitle>
        <ItemDescription>
          {secret.userEmail && (
            <span className="flex items-center gap-1">
              <span className="text-xs">For:</span>
              <span className="font-medium text-foreground text-xs">{secret.userEmail}</span>
            </span>
          )}
          {!secret.userEmail && <span className="text-xs">Project-scoped secret</span>}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {!isCreatingEnvVar ? (
          <Button variant="outline" size="sm" onClick={() => setIsCreatingEnvVar(true)}>
            <Plus className="h-3 w-3 mr-1" />
            Make env var
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <Select
              value={selectedMachineId ?? "global"}
              onValueChange={(v) => setSelectedMachineId(v === "global" ? undefined : v)}
            >
              <SelectTrigger className="w-[150px] h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">Global</SelectItem>
                {machines.map((machine) => (
                  <SelectItem key={machine.id} value={machine.id}>
                    {machine.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={handleCreateEnvVar} disabled={setEnvVar.isPending}>
              {setEnvVar.isPending ? <Spinner className="mr-2" /> : null}
              Create
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setIsCreatingEnvVar(false)}>
              Cancel
            </Button>
          </div>
        )}
      </ItemActions>
    </Item>
  );
}

function EnvVarForm({
  params,
  machines,
}: {
  params: { organizationSlug: string; projectSlug: string };
  machines: Array<{ id: string; name: string }>;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [selectedMachineId, setSelectedMachineId] = useState<string | undefined>(undefined);
  const queryClient = useQueryClient();

  const setEnvVar = useMutation({
    mutationFn: async (input: {
      key: string;
      value: string;
      description?: string;
      machineId?: string;
    }) => {
      return trpcClient.envVar.set.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        key: input.key,
        value: input.value,
        description: input.description,
        machineId: input.machineId,
      });
    },
    onSuccess: () => {
      setKey("");
      setValue("");
      setDescription("");
      toast.success("Environment variable saved!");
      queryClient.invalidateQueries({
        queryKey: trpc.envVar.list.queryKey({
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
        }),
      });
    },
    onError: (error) => {
      toast.error("Failed to save environment variable: " + error.message);
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (key.trim() && value.trim()) {
      setEnvVar.mutate({
        key: key.trim(),
        value: value.trim(),
        description: description.trim() || undefined,
        machineId: selectedMachineId,
      });
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <FieldGroup>
        <FieldSet>
          <Field>
            <FieldLabel htmlFor="env-key">Key</FieldLabel>
            <Input
              id="env-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="API_KEY"
              disabled={setEnvVar.isPending}
              pattern="[A-Z_][A-Z0-9_]*"
              title="Uppercase letters, numbers, and underscores only, starting with a letter or underscore"
              autoFocus
            />
            <FieldDescription>
              Uppercase letters, numbers, and underscores only (e.g., API_KEY, DATABASE_URL)
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="env-value">Value</FieldLabel>
            <Textarea
              id="env-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Enter the secret value"
              disabled={setEnvVar.isPending}
              rows={3}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="env-description">Description (optional)</FieldLabel>
            <Input
              id="env-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g., API key for production environment"
              disabled={setEnvVar.isPending}
            />
            <FieldDescription>
              Helps agents understand the intended use (shown as # comment in .env)
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="env-scope">Scope</FieldLabel>
            <Select
              value={selectedMachineId ?? "global"}
              onValueChange={(v) => setSelectedMachineId(v === "global" ? undefined : v)}
              disabled={setEnvVar.isPending}
            >
              <SelectTrigger id="env-scope" className="w-full">
                <SelectValue placeholder="Select scope" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">
                  <Globe className="h-4 w-4" />
                  Global (all machines)
                </SelectItem>
                {machines.map((machine) => (
                  <SelectItem key={machine.id} value={machine.id}>
                    <Server className="h-4 w-4" />
                    {machine.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              Global variables are available to all machines. Machine-specific variables override
              global ones.
            </FieldDescription>
          </Field>
        </FieldSet>
        <Field orientation="horizontal">
          <Button type="submit" disabled={!key.trim() || !value.trim() || setEnvVar.isPending}>
            {setEnvVar.isPending ? "Saving..." : "Save"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}

function EnvVarSection({
  title,
  icon,
  envVars,
  params,
}: {
  title: string;
  icon: React.ReactNode;
  envVars: Array<{
    id: string;
    key: string;
    type: "user" | "system" | null;
    value: string;
    description: string | null;
    updatedAt: Date;
  }>;
  params: { organizationSlug: string; projectSlug: string };
}) {
  const queryClient = useQueryClient();

  const deleteEnvVar = useMutation({
    mutationFn: async (input: { key: string; machineId?: string | null }) => {
      return trpcClient.envVar.delete.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        key: input.key,
        machineId: input.machineId ?? undefined,
      });
    },
    onSuccess: () => {
      toast.success("Environment variable deleted!");
      queryClient.invalidateQueries({
        queryKey: trpc.envVar.list.queryKey({
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
        }),
      });
    },
    onError: (error) => {
      toast.error("Failed to delete environment variable: " + error.message);
    },
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {icon}
        <h2 className="text-lg font-semibold">{title}</h2>
        <Badge variant="secondary">{envVars.length}</Badge>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Key</TableHead>
            <TableHead>Value</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Last updated</TableHead>
            <TableHead className="w-[50px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {envVars.map((envVar) => (
            <TableRow key={envVar.id}>
              <TableCell className="font-mono">
                <span className="flex items-center gap-2">
                  {envVar.key}
                  {envVar.type === "system" && (
                    <Badge variant="outline" className="text-xs">
                      System
                    </Badge>
                  )}
                </span>
              </TableCell>
              <TableCell className="font-mono text-muted-foreground text-xs max-w-xs truncate">
                {envVar.value}
              </TableCell>
              <TableCell className="text-muted-foreground text-xs max-w-xs truncate">
                {envVar.description || "—"}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {new Date(envVar.updatedAt).toLocaleDateString()}
              </TableCell>
              <TableCell>
                {envVar.type !== "system" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      deleteEnvVar.mutate({
                        key: envVar.key,
                        machineId: null,
                      })
                    }
                    disabled={deleteEnvVar.isPending}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

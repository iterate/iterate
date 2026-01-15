import { useState, type FormEvent } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation } from "@tanstack/react-query";
import { SlidersHorizontal, Trash2, Globe, Server } from "lucide-react";
import { toast } from "sonner";
import { trpc, trpcClient } from "../../../lib/trpc.tsx";
import { EmptyState } from "../../../components/empty-state.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
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

export const Route = createFileRoute(
  "/_auth/orgs/$organizationSlug/projects/$projectSlug/env-vars",
)({
  beforeLoad: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(
        trpc.envVar.list.queryOptions({
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
        }),
      ),
      context.queryClient.ensureQueryData(
        trpc.machine.list.queryOptions({
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
          includeArchived: false,
        }),
      ),
    ]);
  },
  component: ProjectEnvVarsPage,
});

function ProjectEnvVarsPage() {
  const params = useParams({
    from: "/_auth/orgs/$organizationSlug/projects/$projectSlug/env-vars",
  });
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [selectedMachineId, setSelectedMachineId] = useState<string | undefined>(undefined);

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
      setKey("");
      setValue("");
      toast.success("Environment variable saved!");
    },
    onError: (error) => {
      toast.error("Failed to save environment variable: " + error.message);
    },
  });

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
    },
    onError: (error) => {
      toast.error("Failed to delete environment variable: " + error.message);
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (key.trim() && value.trim()) {
      setEnvVar.mutate({
        key: key.trim(),
        value: value.trim(),
        machineId: selectedMachineId,
      });
    }
  };

  const hasAnyEnvVars = envVars.length > 0;

  return (
    <div className="p-4 space-y-6">
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

      {hasAnyEnvVars ? (
        <div className="space-y-8">
          {globalEnvVars.length > 0 && (
            <EnvVarSection
              title="Global"
              icon={<Globe className="h-4 w-4" />}
              envVars={globalEnvVars}
              onDelete={(key) => deleteEnvVar.mutate({ key, machineId: null })}
              isDeleting={deleteEnvVar.isPending}
            />
          )}

          {Array.from(machineEnvVarsMap.entries()).map(([machineId, vars]) => (
            <EnvVarSection
              key={machineId}
              title={getMachineName(machineId)}
              icon={<Server className="h-4 w-4" />}
              envVars={vars}
              onDelete={(key) => deleteEnvVar.mutate({ key, machineId })}
              isDeleting={deleteEnvVar.isPending}
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
    </div>
  );
}

function EnvVarSection({
  title,
  icon,
  envVars,
  onDelete,
  isDeleting,
}: {
  title: string;
  icon: React.ReactNode;
  envVars: Array<{
    id: string;
    key: string;
    type: "user" | "system" | null;
    maskedValue: string;
    updatedAt: Date;
  }>;
  onDelete: (key: string) => void;
  isDeleting: boolean;
}) {
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
              <TableCell className="font-mono text-muted-foreground">
                {envVar.maskedValue}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {new Date(envVar.updatedAt).toLocaleDateString()}
              </TableCell>
              <TableCell>
                {envVar.type !== "system" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onDelete(envVar.key)}
                    disabled={isDeleting}
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

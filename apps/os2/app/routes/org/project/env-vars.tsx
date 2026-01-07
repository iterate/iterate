import { useState, Suspense, type FormEvent } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation } from "@tanstack/react-query";
import { SlidersHorizontal, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc, trpcClient } from "../../../lib/trpc.tsx";
import { EmptyState } from "../../../components/empty-state.tsx";
import { Button } from "../../../components/ui/button.tsx";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table.tsx";
import { Spinner } from "../../../components/ui/spinner.tsx";

export const Route = createFileRoute(
  "/_auth.layout/orgs/$organizationSlug/projects/$projectSlug/env-vars",
)({
  component: ProjectEnvVarsRoute,
});

function ProjectEnvVarsRoute() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <ProjectEnvVarsPage />
    </Suspense>
  );
}

function ProjectEnvVarsPage() {
  const params = useParams({
    from: "/_auth.layout/orgs/$organizationSlug/projects/$projectSlug/env-vars",
  });
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");

  const { data: envVars } = useSuspenseQuery(
    trpc.envVar.list.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
    }),
  );

  const setEnvVar = useMutation({
    mutationFn: async (input: { key: string; value: string }) => {
      return trpcClient.envVar.set.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        key: input.key,
        value: input.value,
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
    mutationFn: async (keyToDelete: string) => {
      return trpcClient.envVar.delete.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        key: keyToDelete,
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
      setEnvVar.mutate({ key: key.trim(), value: value.trim() });
    }
  };

  return (
    <div className="p-8 max-w-4xl space-y-6">
      <h1 className="text-2xl font-bold">Environment variables</h1>

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
          </FieldSet>
          <Field orientation="horizontal">
            <Button type="submit" disabled={!key.trim() || !value.trim() || setEnvVar.isPending}>
              {setEnvVar.isPending ? "Saving..." : "Save"}
            </Button>
          </Field>
        </FieldGroup>
      </form>

      {envVars && envVars.length > 0 ? (
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
                <TableCell className="font-mono">{envVar.key}</TableCell>
                <TableCell className="font-mono text-muted-foreground">{envVar.maskedValue}</TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(envVar.updatedAt).toLocaleDateString()}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => deleteEnvVar.mutate(envVar.key)}
                    disabled={deleteEnvVar.isPending}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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

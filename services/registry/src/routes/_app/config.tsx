import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Braces, Save } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@iterate-com/ui/components/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { orpc } from "@/lib/orpc.ts";

export const Route = createFileRoute("/_app/config")({
  ssr: false,
  component: ConfigPage,
});

function ConfigPage() {
  const queryClient = useQueryClient();
  const { data } = useQuery(orpc.config.list.queryOptions());
  const [key, setKey] = useState("");
  const [value, setValue] = useState('{\n  "example": true\n}');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation(
    orpc.config.set.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: orpc.config.list.key() });
        setError(null);
      },
    }),
  );

  const entries = data?.entries ?? [];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Set config entry</CardTitle>
            <CardDescription>
              Persist arbitrary JSON configuration in the registry store.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field>
              <FieldLabel htmlFor="config-key">Key</FieldLabel>
              <FieldContent>
                <Input
                  id="config-key"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder="registry.db.theme"
                />
              </FieldContent>
            </Field>

            <Field>
              <FieldLabel htmlFor="config-value">JSON value</FieldLabel>
              <FieldContent>
                <Textarea
                  id="config-value"
                  className="min-h-48 font-mono text-xs"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
                <FieldDescription>Objects, arrays, scalars, or strings all work.</FieldDescription>
              </FieldContent>
            </Field>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}

            <Button
              onClick={() => {
                try {
                  mutation.mutate({
                    key: key.trim(),
                    value: JSON.parse(value),
                  });
                } catch (parseError) {
                  setError(parseError instanceof Error ? parseError.message : String(parseError));
                }
              }}
              disabled={mutation.isPending || key.trim().length === 0}
            >
              <Save className="size-4" />
              {mutation.isPending ? "Saving..." : "Save config"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Stored entries</CardTitle>
            <CardDescription>
              {String(entries.length)} config values are currently persisted.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {entries.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Braces className="size-5" />
                  </EmptyMedia>
                  <EmptyTitle>No config entries</EmptyTitle>
                  <EmptyDescription>
                    Write the first key on the left to seed the config store.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              entries.map((entry) => (
                <div key={entry.key} className="rounded-xl border p-4">
                  <div className="flex items-center justify-between gap-4">
                    <p className="font-medium">{entry.key}</p>
                    <p className="text-xs text-muted-foreground">{formatDate(entry.updatedAt)}</p>
                  </div>
                  <pre className="mt-3 overflow-x-auto rounded-lg bg-muted/60 p-3 text-xs whitespace-pre-wrap">
                    {JSON.stringify(entry.value, null, 2)}
                  </pre>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

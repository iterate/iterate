import { useState, type FormEvent, Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc, trpcClient } from "../../lib/trpc.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Field, FieldGroup, FieldLabel, FieldSet } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";

export const Route = createFileRoute("/_auth.layout/user/settings")({
  component: UserSettingsRoute,
});

function UserSettingsRoute() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/50">
      <Suspense fallback={<div className="text-muted-foreground">Loading...</div>}>
        <UserSettingsPage />
      </Suspense>
    </div>
  );
}

function UserSettingsPage() {
  const { data: user } = useSuspenseQuery(trpc.user.me.queryOptions());

  const updateUser = useMutation({
    mutationFn: async (name: string) => {
      return trpcClient.user.updateSettings.mutate({ name });
    },
    onSuccess: () => {
      toast.success("Settings updated");
    },
    onError: (error) => {
      toast.error("Failed to update settings: " + error.message);
    },
  });

  if (!user) {
    return <div className="text-muted-foreground">User not found</div>;
  }

  return (
    <UserSettingsForm
      key={user.id}
      user={{ id: user.id, name: user.name, email: user.email }}
      isSaving={updateUser.isPending}
      onSubmit={(name) => updateUser.mutate(name)}
    />
  );
}

type UserSettingsFormProps = {
  user: {
    id: string;
    name: string;
    email: string;
  };
  isSaving: boolean;
  onSubmit: (name: string) => void;
};

function UserSettingsForm({ user, isSaving, onSubmit }: UserSettingsFormProps) {
  const [name, setName] = useState(user.name);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && name !== user.name) {
      onSubmit(name.trim());
    }
  };

  return (
    <div className="w-full max-w-md space-y-6">
      <h1 className="text-2xl font-semibold">User settings</h1>
      <form onSubmit={handleSubmit}>
        <FieldGroup>
          <FieldSet>
            <Field>
              <FieldLabel htmlFor="user-name">Name</FieldLabel>
              <Input
                id="user-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={isSaving}
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="user-email">Email</FieldLabel>
              <Input id="user-email" value={user.email} disabled />
            </Field>
          </FieldSet>
          <Field orientation="horizontal">
            <Button type="submit" disabled={!name.trim() || name === user.name || isSaving}>
              {isSaving ? "Saving..." : "Save"}
            </Button>
          </Field>
        </FieldGroup>
      </form>
    </div>
  );
}

import { useState, type FormEvent, Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { orpc, orpcClient } from "../../lib/orpc.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";

export const Route = createFileRoute("/_auth-required/user/settings")({
  component: UserSettingsRoute,
});

function UserSettingsRoute() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      }
    >
      <UserSettingsPage />
    </Suspense>
  );
}

type User = { id: string; name: string; email: string };

function UserSettingsPage() {
  const { data: user } = useSuspenseQuery(orpc.user.me.queryOptions()) as { data: User | null };

  const updateUser = useMutation({
    mutationFn: async (name: string) => {
      return orpcClient.user.updateSettings({ name });
    },
    onSuccess: () => {
      toast.success("Settings updated");
    },
    onError: (error) => {
      toast.error("Failed to update settings: " + error.message);
    },
  });

  if (!user) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">User not found</div>
      </div>
    );
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
    <div className="p-8 max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">User settings</h1>
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

import { useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { trpc, trpcClient } from "../../lib/trpc.tsx";
import { Button } from "../../components/ui/button.tsx";
import { CenteredLayout } from "../../components/centered-layout.tsx";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx";

export const Route = createFileRoute("/_auth/user/settings")({
  // loader: For data fetching (runs in parallel after beforeLoad)
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(trpc.user.me.queryOptions());
  },
  component: UserSettingsPage,
});

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
    return (
      <CenteredLayout>
        <div className="text-muted-foreground">User not found</div>
      </CenteredLayout>
    );
  }

  return (
    <CenteredLayout>
      <UserSettingsForm
        key={user.id}
        user={{ id: user.id, name: user.name, email: user.email }}
        isSaving={updateUser.isPending}
        onSubmit={(name) => updateUser.mutate(name)}
      />
    </CenteredLayout>
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
  const { theme, setTheme } = useTheme();

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

      <FieldGroup>
        <FieldSet>
          <Field>
            <FieldLabel htmlFor="theme">Theme</FieldLabel>
            <Select value={theme} onValueChange={setTheme}>
              <SelectTrigger id="theme">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="system">System</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>Changes are saved automatically</FieldDescription>
          </Field>
        </FieldSet>
      </FieldGroup>
    </div>
  );
}

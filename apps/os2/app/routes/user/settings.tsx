import { useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc, trpcClient } from "../../lib/trpc.ts";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";

export const Route = createFileRoute("/_auth-required.layout/user/settings")({
  component: UserSettingsPage,
});

function UserSettingsPage() {
  const queryClient = useQueryClient();
  const { data: user, isLoading } = useQuery(trpc.user.me.queryOptions());

  const updateUser = useMutation({
    mutationFn: async (name: string) => {
      return trpcClient.user.updateSettings.mutate({ name });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.user.me.queryKey() });
      toast.success("Settings updated");
    },
    onError: (error) => {
      toast.error("Failed to update settings: " + error.message);
    },
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

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
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="user-name">
            Name
          </label>
          <Input
            id="user-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={isSaving}
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-muted-foreground" htmlFor="user-email">
            Email
          </label>
          <Input id="user-email" value={user.email} disabled />
        </div>
        <Button type="submit" disabled={!name.trim() || name === user.name || isSaving}>
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </form>
    </div>
  );
}

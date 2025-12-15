import { useState, Suspense } from "react";
import { Save, ArrowLeft } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { createFileRoute } from "@tanstack/react-router";
import { Spinner } from "../components/ui/spinner.tsx";
import { useTRPC } from "../lib/trpc.ts";
import { authClient } from "../lib/auth-client.ts";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { Switch } from "../components/ui/switch.tsx";
import { Avatar, AvatarImage, AvatarFallback } from "../components/ui/avatar.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.tsx";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../components/ui/field.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../components/ui/alert-dialog.tsx";
import { useSessionUser } from "../hooks/use-session-user.ts";

export const Route = createFileRoute("/_auth.layout/user-settings")({
  component: UserSettings,
  head: () => ({
    meta: [
      {
        title: "User Settings - Iterate",
      },
      {
        name: "description",
        content: "Manage your profile information and account preferences",
      },
    ],
  }),
});

function UserSettingsContent() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const user = useSessionUser();
  const queryClient = useQueryClient();
  const router = useRouter();

  const [userName, setUserName] = useState(user.name);
  const [debugMode, setDebugMode] = useState(user.debugMode);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const updateUser = useMutation(
    trpc.user.updateProfile.mutationOptions({
      onSuccess: async (data) => {
        toast.success("User settings updated successfully");
        queryClient.invalidateQueries({ queryKey: trpc.user.me.queryKey() });
        setUserName(data.name);
        setDebugMode(data.debugMode ?? false);
        setError(null);
      },
      onError: (error) => {
        setError(error.message);
      },
    }),
  );

  const deleteUser = useMutation(trpc.user.deleteAccount.mutationOptions({}));

  const handleDeleteUser = async () => {
    setDeleteError(null);

    try {
      await deleteUser.mutateAsync();
    } catch (mutationError) {
      setDeleteError(
        mutationError instanceof Error ? mutationError.message : "Failed to delete user",
      );
      return;
    }

    setIsDeleteDialogOpen(false);

    let hasRedirected = false;

    try {
      await authClient.signOut({
        fetchOptions: {
          onSuccess: () => {
            hasRedirected = true;
            window.location.href = "/login";
          },
        },
      });
    } catch (_signOutError) {
      // Ignore sign out errors and fall back to a manual redirect below.
    }

    if (!hasRedirected) {
      window.location.href = "/login";
    }
  };

  const handleDeleteDialogChange = (open: boolean) => {
    if (deleteUser.isPending) {
      return;
    }

    setIsDeleteDialogOpen(open);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!userName.trim()) {
      setError("Name is required");
      return;
    }

    if (userName === user.name && debugMode === (user.debugMode || false)) {
      setError("No changes to save");
      return;
    }

    const updates: { name?: string; debugMode?: boolean } = {};

    if (userName !== user.name) {
      updates.name = userName;
    }

    if (debugMode !== (user.debugMode || false)) {
      updates.debugMode = debugMode;
    }

    updateUser.mutate(updates);
  };

  const hasChanges = userName !== user.name || debugMode !== (user.debugMode || false);

  const handleGoBack = () => {
    // Try to go back in history, fallback to root if no history
    if (router.history.canGoBack()) {
      router.history.back();
    } else {
      navigate({ to: "/" });
    }
  };

  const userInitials = user.name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase();

  return (
    <div className="container mx-auto p-4 max-w-3xl">
      {/* Header with back button */}
      <Button variant="ghost" size="sm" onClick={handleGoBack} className="mb-2">
        <ArrowLeft className="h-4 w-4 mr-2" />
        Back to dashboard
      </Button>

      <div className="grid gap-6">
        {/* Profile Information */}
        <Card variant="muted">
          <CardContent>
            <form onSubmit={handleSubmit}>
              <FieldSet>
                <FieldLegend>Profile Information</FieldLegend>
                <FieldDescription>
                  Manage your profile information and account preferences
                </FieldDescription>
                <FieldGroup>
                  {/* Avatar and User ID */}
                  <div className="flex items-center gap-4">
                    <Avatar className="h-16 w-16">
                      <AvatarImage src={user.image || undefined} alt={user.name || ""} />
                      <AvatarFallback className="text-lg">{userInitials}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <FieldLabel className="text-sm font-medium text-muted-foreground">
                        User ID
                      </FieldLabel>
                      <p className="font-mono text-sm bg-muted px-2 py-1 rounded w-full truncate">
                        {user.id}
                      </p>
                    </div>
                  </div>

                  {/* Name Input */}
                  <Field>
                    <FieldLabel htmlFor="name">Full Name</FieldLabel>
                    <Input
                      id="name"
                      value={userName}
                      onChange={(e) => {
                        setUserName(e.target.value);
                        setError(null);
                      }}
                      disabled={updateUser.isPending}
                    />
                  </Field>

                  {/* Email (Read-only) */}
                  <Field>
                    <FieldLabel htmlFor="email">Email Address</FieldLabel>
                    <Input id="email" value={user.email || ""} disabled className="bg-muted" />
                    <FieldDescription>
                      Email cannot be changed. Contact support if you need to update your email.
                    </FieldDescription>
                  </Field>

                  {/* Debug Mode Toggle */}
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor="debug-mode">Debug Mode</FieldLabel>
                      <FieldDescription>
                        Enable additional debugging information and developer features
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      id="debug-mode"
                      checked={debugMode}
                      onCheckedChange={(checked) => {
                        setDebugMode(checked);
                        setError(null);
                      }}
                      disabled={updateUser.isPending}
                    />
                  </Field>

                  {/* Error Messages */}
                  {error && (
                    <div className="bg-destructive/15 text-destructive px-3 py-2 rounded-md text-sm">
                      {error}
                    </div>
                  )}

                  {/* Submit Button */}
                  <Button
                    type="submit"
                    disabled={!hasChanges || updateUser.isPending}
                    className="w-full sm:w-auto"
                  >
                    {updateUser.isPending ? (
                      <>
                        <Spinner className="mr-2 h-4 w-4" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Save className="mr-2 h-4 w-4" />
                        Save Changes
                      </>
                    )}
                  </Button>
                </FieldGroup>
              </FieldSet>
            </form>
          </CardContent>
        </Card>

        <Card variant="muted">
          <CardHeader>
            <CardTitle>Danger Zone</CardTitle>
            <CardDescription>
              Permanently delete your user account and all associated data.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AlertDialog open={isDeleteDialogOpen} onOpenChange={handleDeleteDialogChange}>
              <AlertDialogTrigger asChild>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setDeleteError(null);
                  }}
                  disabled={deleteUser.isPending}
                >
                  Permanently delete user
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete user account?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This action cannot be undone. Deleting your user will also remove every
                    organization and installation you own and delete the Stripe customer and billing
                    relationship associated with your account.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={deleteUser.isPending}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleDeleteUser}
                    disabled={deleteUser.isPending}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {deleteUser.isPending ? (
                      <>
                        <Spinner className="mr-2 h-4 w-4" />
                        Deleting...
                      </>
                    ) : (
                      "Delete user"
                    )}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            {deleteError && (
              <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {deleteError}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function UserSettings() {
  const navigate = useNavigate();
  const router = useRouter();

  const handleGoBack = () => {
    // Try to go back in history, fallback to root if no history
    if (router.history.canGoBack()) {
      router.history.back();
    } else {
      navigate({ to: "/" });
    }
  };

  return (
    <Suspense
      fallback={
        <div className="container mx-auto py-8 max-w-3xl">
          {/* Header with back button - same as main content */}
          <div className="space-y-4 mb-6">
            <Button variant="ghost" size="sm" onClick={handleGoBack} className="pl-0">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <div>
              <h1 className="text-3xl font-bold">User Settings</h1>
              <p className="text-muted-foreground">
                Manage your profile information and account preferences
              </p>
            </div>
          </div>
          <div className="flex items-center justify-center py-16">
            <Spinner className="h-8 w-8" />
          </div>
        </div>
      }
    >
      <UserSettingsContent />
    </Suspense>
  );
}

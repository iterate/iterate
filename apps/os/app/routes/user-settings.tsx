import { useState, Suspense } from "react";
import { Settings, Loader2, Save, User, Shield, ArrowLeft } from "lucide-react";
import { useSuspenseQuery, useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { useTRPC } from "../lib/trpc.ts";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { Label } from "../components/ui/label.tsx";
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
import type { Route } from "./+types/user-settings";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "User Settings - Iterate" },
    { name: "description", content: "Manage your user profile and preferences" },
  ];
}

function UserSettingsContent() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const { data: user } = useSuspenseQuery(trpc.user.me.queryOptions());

  const [userName, setUserName] = useState(user.name);
  const [debugMode, setDebugMode] = useState(user.debugMode || false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const updateUser = useMutation(
    trpc.user.updateProfile.mutationOptions({
      onSuccess: (data) => {
        setSuccessMessage("User settings updated successfully");
        setUserName(data.name);
        setDebugMode(data.debugMode || false);
        setError(null);
        // Clear success message after 3 seconds
        setTimeout(() => setSuccessMessage(null), 3000);
      },
      onError: (error) => {
        setError(error.message);
        setSuccessMessage(null);
      },
    }),
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);

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
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate("/");
    }
  };

  const userInitials = user.name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase();

  return (
    <div className="container mx-auto py-8 max-w-4xl">
      {/* Header with back button */}
      <div className="flex items-center gap-4 mb-6">
        <Button variant="ghost" size="sm" onClick={handleGoBack}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Settings className="h-8 w-8" />
            User Settings
          </h1>
          <p className="text-muted-foreground">
            Manage your profile information and account preferences
          </p>
        </div>
      </div>

      <div className="grid gap-6">
        {/* Profile Information */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              Profile Information
            </CardTitle>
            <CardDescription>
              Update your personal information and display preferences
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Avatar and User ID */}
              <div className="flex items-center gap-4">
                <Avatar className="h-16 w-16">
                  <AvatarImage src={user.image || undefined} alt={user.name} />
                  <AvatarFallback className="text-lg">{userInitials}</AvatarFallback>
                </Avatar>
                <div>
                  <Label className="text-sm font-medium text-muted-foreground">User ID</Label>
                  <p className="font-mono text-sm bg-muted px-2 py-1 rounded">{user.id}</p>
                </div>
              </div>

              {/* Name Input */}
              <div className="space-y-2">
                <Label htmlFor="name">Full Name</Label>
                <Input
                  id="name"
                  value={userName}
                  onChange={(e) => {
                    setUserName(e.target.value);
                    setError(null);
                    setSuccessMessage(null);
                  }}
                  disabled={updateUser.isPending}
                />
              </div>

              {/* Email (Read-only) */}
              <div className="space-y-2">
                <Label htmlFor="email">Email Address</Label>
                <Input id="email" value={user.email} disabled className="bg-muted" />
                <p className="text-xs text-muted-foreground">
                  Email cannot be changed. Contact support if you need to update your email.
                </p>
              </div>

              {/* Debug Mode Toggle */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label className="flex items-center gap-2">
                      <Shield className="h-4 w-4" />
                      Debug Mode
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      Enable additional debugging information and developer features
                    </p>
                  </div>
                  <Switch
                    checked={debugMode}
                    onCheckedChange={(checked) => {
                      setDebugMode(checked);
                      setError(null);
                      setSuccessMessage(null);
                    }}
                    disabled={updateUser.isPending}
                  />
                </div>
              </div>

              {/* Error/Success Messages */}
              {error && (
                <div className="bg-destructive/15 text-destructive px-3 py-2 rounded-md text-sm">
                  {error}
                </div>
              )}
              {successMessage && (
                <div className="bg-green-50 text-green-700 px-3 py-2 rounded-md text-sm border border-green-200">
                  {successMessage}
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
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="mr-2 h-4 w-4" />
                    Save Changes
                  </>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Danger Zone</CardTitle>
            <CardDescription>
              Permanently delete your user account and all associated data.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive">Permanently delete user</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete user account?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This action cannot be undone. Deleting your user will also remove every
                    organization and estate you own and delete the Stripe customer and billing
                    relationship associated with your account.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                    Delete user
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function UserSettings() {
  const navigate = useNavigate();

  const handleGoBack = () => {
    // Try to go back in history, fallback to root if no history
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate("/");
    }
  };

  return (
    <Suspense
      fallback={
        <div className="container mx-auto py-8 max-w-4xl">
          {/* Header with back button - same as main content */}
          <div className="flex items-center gap-4 mb-6">
            <Button variant="ghost" size="sm" onClick={handleGoBack}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <div>
              <h1 className="text-3xl font-bold flex items-center gap-2">
                <Settings className="h-8 w-8" />
                User Settings
              </h1>
              <p className="text-muted-foreground">
                Manage your profile information and account preferences
              </p>
            </div>
          </div>
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin" />
          </div>
        </div>
      }
    >
      <UserSettingsContent />
    </Suspense>
  );
}

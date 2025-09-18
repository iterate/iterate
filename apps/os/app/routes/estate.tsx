import { useState } from "react";
import { Github, ArrowRight, Edit2, Check, X } from "lucide-react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { DashboardLayout } from "../components/dashboard-layout.tsx";
import { trpc } from "../lib/trpc.ts";
import type { Route } from "./+types/estate";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Manage Estate - Iterate Dashboard" },
    {
      name: "description",
      content: "Manage your estate and connect to GitHub",
    },
  ];
}

function EstateContent() {
  const [isEditing, setIsEditing] = useState(false);
  const [tempTitle, setTempTitle] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [connectedRepo, setConnectedRepo] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // Get user's estate ID
  const [estateIdData] = trpc.integrations.getCurrentUserEstateId.useSuspenseQuery();

  // Get estate details
  const [estate] = trpc.estate.get.useSuspenseQuery({
    estateId: estateIdData.estateId,
  });

  // Update estate name mutation
  const updateEstateMutation = trpc.estate.updateName.useMutation();

  const title = estate.name;

  // Initialize temp title when estate data loads
  if (estate && tempTitle === "" && !isEditing) {
    setTempTitle(estate.name);
  }

  const handleEditTitle = () => {
    setIsEditing(true);
    setTempTitle(title);
  };

  const handleSaveTitle = async () => {
    if (tempTitle.trim() === title) {
      setIsEditing(false);
      return;
    }

    setIsSaving(true);
    try {
      await updateEstateMutation.mutateAsync({
        estateId: estateIdData.estateId,
        name: tempTitle.trim(),
      });
      setIsEditing(false);
    } catch (error) {
      console.error("Failed to update estate name:", error);
      // Reset temp title on error
      setTempTitle(title);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setTempTitle(title);
    setIsEditing(false);
  };

  const handleConnectGitHub = () => {
    // Simulate connecting to GitHub
    setIsConnected(true);
    setConnectedRepo("nickblow/my-estate-repo");
  };

  const handleGoToGitHub = () => {
    // Open GitHub
    window.open("https://github.com", "_blank");
  };

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto px-8 pt-16 pb-8">
        {/* Editable Title */}
        <div className="mb-12">
          {isEditing ? (
            <div className="flex items-center gap-3 mb-4">
              <Input
                value={tempTitle}
                onChange={(e) => setTempTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !isSaving &&
                    tempTitle.trim() &&
                    tempTitle.trim() !== title
                  ) {
                    handleSaveTitle();
                  } else if (e.key === "Escape") {
                    handleCancelEdit();
                  }
                }}
                className="text-3xl font-bold border-none p-0 h-auto text-slate-900 dark:text-white focus-visible:ring-0 focus-visible:ring-offset-0"
                style={{ fontSize: "1.875rem", lineHeight: "2.25rem" }}
                disabled={isSaving}
                autoFocus
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleSaveTitle}
                  disabled={isSaving || !tempTitle.trim() || tempTitle.trim() === title}
                >
                  <Check className="w-4 h-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={handleCancelEdit} disabled={isSaving}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 mb-4">
              <h1 className="text-3xl font-bold text-slate-900 dark:text-white">{title}</h1>
              <Button size="sm" variant="ghost" onClick={handleEditTitle}>
                <Edit2 className="w-4 h-4" />
              </Button>
            </div>
          )}
          <p className="text-slate-600 dark:text-slate-300 text-lg">
            Connect your GitHub repository to manage your digital estate
          </p>
        </div>

        {/* GitHub Connection */}
        <div className="mb-8">
          <div className="w-20 h-20 mb-6 rounded-2xl bg-gray-900 flex items-center justify-center">
            <Github className="w-10 h-10 text-white" />
          </div>

          <h2 className="text-3xl font-bold text-slate-900 dark:text-white mb-4">Connect GitHub</h2>

          <p className="text-slate-600 dark:text-slate-300 text-lg leading-relaxed mb-8">
            Connect your GitHub account to automatically manage your digital estate, backup
            important repositories, and ensure your code legacy is preserved.
          </p>
        </div>

        {/* Connection Status */}
        {isConnected ? (
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Check className="h-6 w-6 text-green-600 dark:text-green-400" />
              <span className="text-green-700 dark:text-green-300 font-medium">
                Connected to {connectedRepo}
              </span>
            </div>

            <Button
              size="lg"
              className="bg-gradient-to-r from-gray-800 to-gray-900 hover:from-gray-900 hover:to-black text-white font-semibold px-8 py-4 h-12"
              onClick={handleGoToGitHub}
            >
              Go to GitHub
              <ArrowRight className="h-4 w-4 ml-3" />
            </Button>
          </div>
        ) : (
          <Button
            size="lg"
            className="bg-gradient-to-r from-gray-800 to-gray-900 hover:from-gray-900 hover:to-black text-white font-semibold px-8 py-4 h-12"
            onClick={handleConnectGitHub}
          >
            Connect GitHub
            <ArrowRight className="h-4 w-4 ml-3" />
          </Button>
        )}
      </div>
    </DashboardLayout>
  );
}

export default function ManageEstate() {
  return <EstateContent />;
}

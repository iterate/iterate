import React, { useState } from "react";
import { Github, ArrowRight, Edit2, Check, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { DashboardLayout } from "../components/dashboard-layout.tsx";
import { trpc } from "../lib/trpc.ts";

interface EditableTitleProps {
  value: string;
  isEditing: boolean;
  onToggleEdit: () => void;
  onSave: (value: string) => void;
  isLoading?: boolean;
}

function EditableTitle({ value, isEditing, onToggleEdit, onSave, isLoading }: EditableTitleProps) {
  const [tempValue, setTempValue] = useState(value);

  const handleSave = () => {
    onSave(tempValue);
  };

  const handleCancel = () => {
    setTempValue(value);
    onToggleEdit();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && tempValue.trim() && tempValue.trim() !== value) {
      handleSave();
    } else if (e.key === "Escape") {
      handleCancel();
    }
  };

  // Update temp value when the actual value changes (from optimistic updates)
  if (value !== tempValue && !isEditing) {
    setTempValue(value);
  }

  return (
    <div className="flex items-center gap-3 mb-4">
      {isEditing ? (
        <>
          <Input
            value={tempValue}
            onChange={(e) => setTempValue(e.target.value)}
            onKeyDown={handleKeyDown}
            className="text-3xl font-bold border-none p-0 h-auto text-slate-900 dark:text-white focus-visible:ring-0 focus-visible:ring-offset-0 bg-transparent"
            style={{ fontSize: "1.875rem", lineHeight: "2.25rem" }}
            disabled={isLoading}
            autoFocus
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={handleSave}
              disabled={isLoading || !tempValue.trim() || tempValue.trim() === value}
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Check className="w-4 h-4" />
              )}
            </Button>
            <Button size="sm" variant="ghost" onClick={handleCancel} disabled={isLoading}>
              <X className="w-4 h-4" />
            </Button>
          </div>
        </>
      ) : (
        <>
          <h1
            className="text-3xl font-bold text-slate-900 dark:text-white cursor-pointer hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
            onClick={onToggleEdit}
          >
            {value}
          </h1>
          <Button size="sm" variant="ghost" onClick={onToggleEdit}>
            <Edit2 className="w-4 h-4" />
          </Button>
        </>
      )}
    </div>
  );
}

export function meta() {
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
  const [isConnected, setIsConnected] = useState(false);
  const [connectedRepo, setConnectedRepo] = useState("");

  // Get user's estate ID
  const [estateIdData] = trpc.integrations.getCurrentUserEstateId.useSuspenseQuery();

  // Get estate details
  const [estate] = trpc.estate.get.useSuspenseQuery({
    estateId: estateIdData.estateId,
  });

  // Update estate name mutation with optimistic updates
  const utils = trpc.useUtils();
  const updateEstateMutation = trpc.estate.updateName.useMutation({
    onMutate: async (newData) => {
      // Cancel any outgoing refetches
      await utils.estate.get.cancel({ estateId: estateIdData.estateId });

      // Snapshot the previous value
      const previousEstate = utils.estate.get.getData({ estateId: estateIdData.estateId });

      // Optimistically update to the new value
      utils.estate.get.setData({ estateId: estateIdData.estateId }, (old) =>
        old ? { ...old, name: newData.name } : old,
      );

      return { previousEstate };
    },
    onError: (_err, _newData, context) => {
      // If the mutation fails, use the context returned from onMutate to roll back
      utils.estate.get.setData({ estateId: estateIdData.estateId }, context?.previousEstate);
      toast.error("Failed to update estate name");
    },
    onSettled: () => {
      // Always refetch after error or success to ensure we have the latest data
      utils.estate.get.invalidate({ estateId: estateIdData.estateId });
    },
  });

  const handleToggleEdit = () => {
    setIsEditing(!isEditing);
  };

  const handleSave = async (newName: string) => {
    if (newName.trim() === estate.name || !newName.trim()) {
      setIsEditing(false);
      return;
    }

    await updateEstateMutation.mutateAsync({
      estateId: estateIdData.estateId,
      name: newName.trim(),
    });

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
          <EditableTitle
            value={estate.name}
            isEditing={isEditing}
            onToggleEdit={handleToggleEdit}
            onSave={handleSave}
            isLoading={updateEstateMutation.isPending}
          />
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

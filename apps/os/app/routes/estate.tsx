import React, { useState } from "react";
import { Github, ArrowRight, Edit2, Check, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { useTRPC } from "../lib/trpc.ts";
import { useEstateId } from "../hooks/use-estate.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.tsx";

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

  // Get estate ID from URL
  const estateId = useEstateId();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Get estate details
  const { data: estate } = useSuspenseQuery(
    trpc.estate.get.queryOptions({
      estateId: estateId,
    }),
  );

  const { data: connectedRepo } = useSuspenseQuery(
    trpc.integrations.getGithubRepoForEstate.queryOptions({
      estateId: estateId,
    }),
  );
  const { data: repos } = useSuspenseQuery(
    trpc.integrations.listAvailableGithubRepos.queryOptions({
      estateId: estateId,
    }),
  );

  const updateEstateMutation = useMutation(
    trpc.estate.updateName.mutationOptions({
      onMutate: async (newData) => {
        // Cancel any outgoing refetches
        await queryClient.cancelQueries({
          queryKey: trpc.estate.get.queryKey({ estateId: estateId! }),
        });

        // Snapshot the previous value
        const previousEstate = queryClient.getQueryData(
          trpc.estate.get.queryKey({ estateId: estateId! }),
        );

        // Optimistically update to the new value
        queryClient.setQueryData(trpc.estate.get.queryKey({ estateId: estateId! }), (old) =>
          old ? { ...old, name: newData.name } : old,
        );

        return { previousEstate };
      },
      onError: (_err, _newData, context) => {
        // If the mutation fails, use the context returned from onMutate to roll back
        queryClient.setQueryData(
          trpc.estate.get.queryKey({ estateId: estateId! }),
          context?.previousEstate,
        );
        toast.error("Failed to update estate name");
      },
      onSettled: () => {
        // Always refetch after error or success to ensure we have the latest data
        queryClient.invalidateQueries({
          queryKey: trpc.estate.get.queryKey({ estateId: estateId! }),
        });
      },
    }),
  );

  const handleToggleEdit = () => {
    setIsEditing(!isEditing);
  };

  const handleSave = async (newName: string) => {
    if (newName.trim() === estate.name || !newName.trim()) {
      setIsEditing(false);
      return;
    }

    await updateEstateMutation.mutateAsync({
      estateId: estateId!,
      name: newName.trim(),
    });

    setIsEditing(false);
  };

  const setGithubRepoForEstateMutation = useMutation(
    trpc.integrations.setGithubRepoForEstate.mutationOptions({}),
  );
  const handleSelectRepo = (repoId: string) => {
    setGithubRepoForEstateMutation.mutate(
      {
        estateId: estateId!,
        repoId: parseInt(repoId),
      },
      {
        onError: () => {
          toast.error("Failed to set GitHub repository for estate");
        },
      },
    );
  };

  const handleGoToGitHub = () => {
    // Open GitHub
    window.open("https://github.com", "_blank");
  };

  return (
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
          Connect your GitHub account to automatically manage your digital estate, backup important
          repositories, and ensure your code legacy is preserved.
        </p>
      </div>

      {/* Connection Status */}
      {connectedRepo ? (
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Check className="h-6 w-6 text-green-600 dark:text-green-400" />
            <span className="text-green-700 dark:text-green-300 font-medium">
              Connected to #{connectedRepo.toString()}
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
        <Select onValueChange={handleSelectRepo}>
          <SelectTrigger>
            <SelectValue placeholder="Select a repository" />
          </SelectTrigger>
          <SelectContent>
            {repos?.map((repo) => (
              <SelectItem key={repo.id} value={repo.id.toString()}>
                {repo.full_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

export default function ManageEstate() {
  return <EstateContent />;
}

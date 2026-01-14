import { type ReactNode, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Box, ChevronsUpDown, LogOut, Settings, UserCog } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { fromString } from "typeid-js";
import { authClient, signOut } from "../lib/auth-client.ts";
import { trpc, trpcClient } from "../lib/trpc.tsx";
import { useDebounce } from "../hooks/use-debounce.ts";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar.tsx";
import { Button } from "./ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Input } from "./ui/input.tsx";
import { Label } from "./ui/label.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./ui/sidebar.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";
import { cn } from "@/lib/utils.ts";

interface User {
  name: string;
  email: string;
  image?: string | null;
  role?: string;
}

interface SidebarShellProps {
  header: ReactNode;
  children: ReactNode;
  user: User;
}

type ImpersonationType = "email" | "user_id" | "project_id";

interface ImpersonationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (type: ImpersonationType, value: string) => void;
  isPending?: boolean;
}

function ImpersonationDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
}: ImpersonationDialogProps) {
  const [value, setValue] = useState("");
  const [type, setType] = useState<ImpersonationType>("email");

  const debouncedValue = useDebounce(value, 500);

  const emailUsersQuery = useQuery(
    trpc.admin.searchUsersByEmail.queryOptions(
      { searchEmail: debouncedValue },
      {
        enabled: debouncedValue.length > 0 && type === "email",
      },
    ),
  );

  const isValid = useMemo(() => {
    if (type === "email") {
      return emailUsersQuery.data?.some((user) => user.email.toLowerCase() === value.toLowerCase());
    }
    if (type === "user_id") {
      try {
        fromString(value, "usr");
        return true;
      } catch {
        return false;
      }
    }
    if (type === "project_id") {
      try {
        fromString(value, "prj");
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }, [value, type, emailUsersQuery.data]);

  const handleSubmit = () => {
    if (!value.trim()) return;
    onSubmit(type, value.trim());
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setValue("");
      setType("email");
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Impersonate another user</DialogTitle>
          <DialogDescription>
            Select how you want to identify the user to impersonate
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Identification method</Label>
            <Select
              value={type}
              onValueChange={(v) => {
                setType(v as ImpersonationType);
                setValue("");
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">By Email</SelectItem>
                <SelectItem value="user_id">By User ID</SelectItem>
                <SelectItem value="project_id">By Project ID</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>
              {type === "email" && "Email address"}
              {type === "user_id" && "User ID"}
              {type === "project_id" && "Project ID"}
            </Label>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={
                type === "email"
                  ? "user@example.com"
                  : type === "user_id"
                    ? "usr_xxxxxxxxxxxxxxxxxxxxxxxx"
                    : "prj_xxxxxxxxxxxxxxxxxxxxxxxx"
              }
              className={cn({
                "border-destructive": value.length > 0 && !isValid,
              })}
              aria-invalid={value.length > 0 && !isValid}
              disabled={isPending}
            />
            {type === "email" && emailUsersQuery.data && emailUsersQuery.data.length > 0 && (
              <div className="border rounded-md mt-1 max-h-40 overflow-y-auto">
                {emailUsersQuery.data.map((user) => (
                  <button
                    key={user.id}
                    type="button"
                    className={cn(
                      "w-full text-left px-3 py-2 text-sm hover:bg-accent",
                      value === user.email && "bg-accent",
                    )}
                    onClick={() => setValue(user.email)}
                  >
                    <div className="font-medium">{user.name}</div>
                    <div className="text-muted-foreground text-xs">{user.email}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end space-x-2">
            <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={!isValid || isPending}>
              {isPending ? "Impersonating..." : "Impersonate"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

async function resolveImpersonation(type: ImpersonationType, value: string): Promise<string> {
  if (type === "email") {
    const user = await trpcClient.admin.findUserByEmail.query({ email: value });
    if (!user) {
      throw new Error("User not found");
    }
    return user.id;
  }
  if (type === "user_id") {
    return value;
  }
  if (type === "project_id") {
    const projectOwner = await trpcClient.admin.getProjectOwner.query({ projectId: value });
    if (!projectOwner) {
      throw new Error("Project not found");
    }
    return projectOwner.userId;
  }
  throw new Error("Invalid type");
}

export function SidebarShell({ header, children, user }: SidebarShellProps) {
  const [impersonationDialogOpen, setImpersonationDialogOpen] = useState(false);
  const posthog = usePostHog();

  const impersonationInfoQuery = useQuery(
    trpc.admin.impersonationInfo.queryOptions(undefined, {
      staleTime: 1000 * 60 * 5,
    }),
  );

  const startImpersonation = useMutation({
    mutationFn: async (params: { type: ImpersonationType; value: string }) => {
      const userId = await resolveImpersonation(params.type, params.value);
      await authClient.admin.impersonateUser({ userId });
    },
    onSuccess: () => {
      window.location.href = "/";
    },
    onError: (error) => {
      toast.error(
        `Failed to impersonate user: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });

  const stopImpersonation = useMutation({
    mutationFn: async () => {
      await authClient.admin.stopImpersonating();
    },
    onSuccess: () => {
      window.location.href = "/";
    },
    onError: (error) => {
      toast.error(
        `Failed to stop impersonation: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });

  const handleImpersonationSubmit = (type: ImpersonationType, value: string) => {
    startImpersonation.mutate({ type, value });
  };

  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  const isImpersonating = Boolean(impersonationInfoQuery.data?.impersonatedBy);
  const isAdmin = Boolean(impersonationInfoQuery.data?.isAdmin);

  const tooltipContent = isImpersonating ? `Impersonating ${user.email}` : undefined;

  return (
    <Sidebar>
      <SidebarHeader>{header}</SidebarHeader>
      <SidebarContent>{children}</SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <SidebarMenuButton
                      size="lg"
                      className={cn(
                        "data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground",
                        isImpersonating && "border-2 border-destructive",
                      )}
                    >
                      <Avatar className="h-8 w-8 shrink-0 rounded-lg">
                        <AvatarImage src={user.image ?? undefined} alt={user.name} />
                        <AvatarFallback className="rounded-lg">
                          {getInitials(user.name)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                        <span className="truncate font-medium">{user.name}</span>
                        <span className="truncate text-xs">{user.email}</span>
                      </div>
                      <ChevronsUpDown className="ml-auto size-4 shrink-0" />
                    </SidebarMenuButton>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                {tooltipContent && <TooltipContent side="right">{tooltipContent}</TooltipContent>}
              </Tooltip>
              <DropdownMenuContent
                className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
                side="top"
                align="start"
                sideOffset={4}
              >
                {isAdmin && !isImpersonating && (
                  <DropdownMenuItem onClick={() => setImpersonationDialogOpen(true)}>
                    <UserCog className="mr-2 h-4 w-4" />
                    Impersonate another user
                  </DropdownMenuItem>
                )}
                {isImpersonating && (
                  <DropdownMenuItem
                    onClick={() => stopImpersonation.mutate()}
                    disabled={stopImpersonation.isPending}
                  >
                    <UserCog className="mr-2 h-4 w-4" />
                    {stopImpersonation.isPending ? "Stopping..." : "Stop impersonating"}
                  </DropdownMenuItem>
                )}
                {(isAdmin || isImpersonating) && <DropdownMenuSeparator />}
                <DropdownMenuItem asChild>
                  <Link to="/user/settings">
                    <Settings className="mr-2 h-4 w-4" />
                    User Settings
                  </Link>
                </DropdownMenuItem>
                {user.role === "admin" && (
                  <DropdownMenuItem asChild>
                    <Link to="/admin">
                      <Box className="mr-2 h-4 w-4" />
                      Admin
                    </Link>
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    // Reset PostHog identity before logout to prevent session linking
                    posthog?.reset();
                    signOut().then(() => {
                      window.location.href = "/login";
                    });
                  }}
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>

        {isAdmin && !isImpersonating && (
          <ImpersonationDialog
            open={impersonationDialogOpen}
            onOpenChange={setImpersonationDialogOpen}
            onSubmit={handleImpersonationSubmit}
            isPending={startImpersonation.isPending}
          />
        )}
      </SidebarFooter>
    </Sidebar>
  );
}

import { Link, type LinkProps } from "@tanstack/react-router";
import { ChevronDown, Plus } from "lucide-react";
import { cn } from "../lib/cn.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { BreadcrumbItem, BreadcrumbLink, BreadcrumbPage } from "./ui/breadcrumb.tsx";

// Shared button styling - extracted to eliminate duplication
const DROPDOWN_TRIGGER_CLASSES =
  "flex items-center gap-1 rounded-sm px-1 -mx-1 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1";

interface DropdownItem {
  id: string;
  name: string;
  slug: string;
}

interface BreadcrumbDropdownProps {
  /** Display name of the currently selected item */
  currentName: string;
  /** ID of the currently selected item (for aria-current) */
  currentId: string;
  /** List of items to show in the dropdown */
  items: DropdownItem[];
  /** Whether this breadcrumb represents the current page */
  isCurrentPage?: boolean;
  /** Function that returns Link props for each dropdown item */
  getItemLinkProps: (item: DropdownItem) => Pick<LinkProps, "to" | "params">;
  /** Configuration for the "add" action at the bottom of the dropdown */
  addAction: {
    label: string;
    linkProps: Pick<LinkProps, "to" | "params">;
  };
  /** Accessible label for the dropdown trigger (e.g., "Switch organization") */
  ariaLabel: string;
}

export function BreadcrumbDropdown({
  currentName,
  currentId,
  items,
  isCurrentPage = false,
  getItemLinkProps,
  addAction,
  ariaLabel,
}: BreadcrumbDropdownProps) {
  return (
    <BreadcrumbItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${currentName}, ${ariaLabel}`}
            aria-haspopup="menu"
            className={cn(
              DROPDOWN_TRIGGER_CLASSES,
              isCurrentPage ? "font-normal text-foreground" : "text-muted-foreground",
            )}
          >
            {isCurrentPage ? (
              <BreadcrumbPage className="pointer-events-none">{currentName}</BreadcrumbPage>
            ) : (
              <BreadcrumbLink asChild className="pointer-events-none">
                <span>{currentName}</span>
              </BreadcrumbLink>
            )}
            <ChevronDown className="h-3 w-3 opacity-60" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-48">
          {items.map((item) => {
            const isCurrent = item.id === currentId;
            const linkProps = getItemLinkProps(item);
            return (
              <DropdownMenuItem
                key={item.id}
                asChild
                className="gap-2"
                aria-current={isCurrent ? "true" : undefined}
              >
                <Link {...linkProps}>
                  <div
                    className="flex size-5 items-center justify-center rounded-sm border bg-muted/50"
                    aria-hidden="true"
                  >
                    <span className="text-xs font-medium">{item.name.charAt(0).toUpperCase()}</span>
                  </div>
                  <span>{item.name}</span>
                  {isCurrent && <span className="sr-only">(current)</span>}
                </Link>
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild className="gap-2">
            <Link {...addAction.linkProps}>
              <div
                className="flex size-5 items-center justify-center rounded-sm border border-dashed"
                aria-hidden="true"
              >
                <Plus className="size-3" aria-hidden="true" />
              </div>
              <span className="text-muted-foreground">{addAction.label}</span>
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </BreadcrumbItem>
  );
}

// Convenience components for common use cases

interface OrgBreadcrumbDropdownProps {
  currentName: string;
  currentId: string;
  items: DropdownItem[];
  isCurrentPage?: boolean;
}

export function OrgBreadcrumbDropdown({
  currentName,
  currentId,
  items,
  isCurrentPage = false,
}: OrgBreadcrumbDropdownProps) {
  return (
    <BreadcrumbDropdown
      currentName={currentName}
      currentId={currentId}
      items={items}
      isCurrentPage={isCurrentPage}
      ariaLabel="switch organization"
      getItemLinkProps={(item) => ({
        to: "/orgs/$organizationSlug",
        params: { organizationSlug: item.slug },
      })}
      addAction={{
        label: "Add organization",
        linkProps: { to: "/new-organization" },
      }}
    />
  );
}

interface ProjectBreadcrumbDropdownProps {
  currentName: string;
  currentId: string;
  organizationSlug: string;
  items: DropdownItem[];
  isCurrentPage?: boolean;
}

export function ProjectBreadcrumbDropdown({
  currentName,
  currentId,
  organizationSlug,
  items,
  isCurrentPage = false,
}: ProjectBreadcrumbDropdownProps) {
  return (
    <BreadcrumbDropdown
      currentName={currentName}
      currentId={currentId}
      items={items}
      isCurrentPage={isCurrentPage}
      ariaLabel="switch project"
      getItemLinkProps={(item) => ({
        to: "/orgs/$organizationSlug/projects/$projectSlug",
        params: { organizationSlug, projectSlug: item.slug },
      })}
      addAction={{
        label: "Add project",
        linkProps: {
          to: "/orgs/$organizationSlug/new-project",
          params: { organizationSlug },
        },
      }}
    />
  );
}

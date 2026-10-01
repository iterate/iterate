import { FilesIcon, GitBranchIcon, HistoryIcon, type LucideIcon } from "lucide-react";
import { Button } from "../button.tsx";
import type { RepoIdeSearch } from "./repo-ide-search.ts";

/** The vscode-style strip of sidebars: Files, Source control, History. */
export function RepoIdeActivityStrip({
  search,
  changeCount,
  onSearchChange,
}: {
  search: RepoIdeSearch;
  changeCount: number;
  onSearchChange: (patch: Partial<RepoIdeSearch>) => void;
}) {
  const scm = Boolean(search.scm);
  const history = Boolean(search.history);
  return (
    <div className="flex shrink-0 flex-col items-center gap-1 border-r px-1 py-2">
      <StripButton
        label="Files"
        icon={FilesIcon}
        active={!scm && !history}
        // leaving Source control or History also leaves the pseudo-file (Index, commit diff) it
        // had open
        onClick={() =>
          onSearchChange({
            scm: undefined,
            staged: undefined,
            history: undefined,
            commit: undefined,
          })
        }
      />
      <StripButton
        label="Source control"
        icon={GitBranchIcon}
        active={scm}
        badge={changeCount}
        onClick={() => onSearchChange({ scm: true, history: undefined, commit: undefined })}
      />
      <StripButton
        label="History"
        icon={HistoryIcon}
        active={history}
        onClick={() => onSearchChange({ history: true, scm: undefined, staged: undefined })}
      />
    </div>
  );
}

function StripButton({
  label,
  icon: Icon,
  active,
  badge = 0,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      size="icon"
      title={label}
      // explicit name: the badge inside would otherwise be the accessible name
      aria-label={label}
      onClick={onClick}
      className="relative text-muted-foreground"
    >
      <Icon className="size-4" />
      {badge > 0 ? (
        <span className="absolute -top-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground">
          {badge}
        </span>
      ) : null}
    </Button>
  );
}

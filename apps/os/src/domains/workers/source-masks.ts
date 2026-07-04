import { minimatch } from "minimatch";

/**
 * Include/exclude glob masks over a repo file snapshot.
 *
 * A path is part of the snapshot when any include pattern matches (default:
 * everything) and no exclude pattern matches. Pattern order carries no
 * semantics. `dot: true` because worker projects legitimately carry dotfiles
 * (`.dev.vars`, `.gitignore`) that a default-hidden glob would silently drop.
 */
export function filterWorkerSnapshotPaths(
  paths: string[],
  masks: { exclude?: string[]; include?: string[] },
): string[] {
  const include = masks.include ?? ["**"];
  const exclude = masks.exclude ?? [];
  return paths.filter(
    (path) =>
      include.some((pattern) => minimatch(path, pattern, { dot: true })) &&
      !exclude.some((pattern) => minimatch(path, pattern, { dot: true })),
  );
}

import type { StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";

export function getRelativeStreamPath({
  basePath,
  targetPath,
}: {
  basePath: StreamPathType;
  targetPath: StreamPathType;
}) {
  if (basePath === "/") {
    return `.${targetPath}`;
  }

  const childPrefix = `${basePath}/`;
  if (targetPath.startsWith(childPrefix)) {
    return `.${targetPath.slice(basePath.length)}`;
  }

  return targetPath;
}

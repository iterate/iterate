import { StreamPath, type StreamPath as StreamPathType } from "@iterate-com/events-contract";

export function getAncestorStreamPaths(path: StreamPathType): StreamPathType[] {
  if (path === "/") {
    return [];
  }

  const segments = path.split("/").filter(Boolean);
  const ancestors: StreamPathType[] = ["/"];

  for (let index = 1; index < segments.length; index++) {
    ancestors.push(StreamPath.parse(`/${segments.slice(0, index).join("/")}`));
  }

  return ancestors;
}

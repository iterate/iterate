import { StreamPath } from "@iterate-com/shared/streams/types";

export function resolveStreamPath(args: { currentStreamPath?: StreamPath; streamPath?: string }) {
  const pathText = args.streamPath?.trim();
  if (pathText == null || pathText.length === 0) {
    if (args.currentStreamPath == null) {
      throw new Error("Stream path is required because no current stream is bound.");
    }

    return args.currentStreamPath;
  }

  if (pathText.startsWith("/")) {
    return StreamPath.parse(pathText);
  }

  if (args.currentStreamPath == null) {
    throw new Error("Relative stream path requires a current stream.");
  }

  const relativePath = pathText.startsWith(".") ? pathText : `./${pathText}`;
  const segments = args.currentStreamPath === "/" ? [] : args.currentStreamPath.slice(1).split("/");

  for (const segment of relativePath.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }

    if (segment === "..") {
      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return StreamPath.parse(`/${segments.join("/")}`);
}

export function formatRelativeStreamPath(args: {
  currentStreamPath: StreamPath;
  streamPath: StreamPath;
}) {
  if (args.streamPath === args.currentStreamPath) return ".";

  const currentSegments =
    args.currentStreamPath === "/" ? [] : args.currentStreamPath.slice(1).split("/");
  const targetSegments = args.streamPath === "/" ? [] : args.streamPath.slice(1).split("/");

  while (
    currentSegments.length > 0 &&
    targetSegments.length > 0 &&
    currentSegments[0] === targetSegments[0]
  ) {
    currentSegments.shift();
    targetSegments.shift();
  }

  return [...currentSegments.map(() => ".."), ...targetSegments].join("/") || ".";
}

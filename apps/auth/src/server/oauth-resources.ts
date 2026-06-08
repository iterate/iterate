export function getOsResourceBases() {
  return [
    "https://os.iterate.com",
    "https://os.iterate-dev-jonas.com",
    "https://os.iterate-dev-misha.com",
    "https://os.iterate-dev-rahul.com",
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(
      (previewNumber) => `https://os.iterate-preview-${previewNumber}.com`,
    ),
  ];
}

export function getOsMcpResourceBases() {
  return withRootUrlSlashVariants([
    "https://mcp.iterate.com",
    "https://mcp.iterate-dev-jonas.com",
    "https://mcp.iterate-dev-misha.com",
    "https://mcp.iterate-dev-rahul.com",
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(
      (previewNumber) => `https://mcp.iterate-preview-${previewNumber}.com`,
    ),
    "http://localhost:7301/api/__mcp",
  ]);
}

function withRootUrlSlashVariants(resources: string[]) {
  return [...new Set(resources.flatMap((resource) => [resource, rootUrlSlashVariant(resource)]))];
}

function rootUrlSlashVariant(resource: string) {
  const url = new URL(resource);
  if (url.pathname !== "/") return resource;
  return `${url.origin}/`;
}

const ADMIN_STREAM_RPC_PREFIX = "/api/admin-streams";

export function adminStreamRpcPath(namespace: string, streamPath: string) {
  const normalized =
    streamPath === "" ? "/" : streamPath.startsWith("/") ? streamPath : `/${streamPath}`;
  return normalized === "/"
    ? `${ADMIN_STREAM_RPC_PREFIX}/${encodeURIComponent(namespace)}`
    : `${ADMIN_STREAM_RPC_PREFIX}/${encodeURIComponent(namespace)}/${encodeURIComponent(normalized)}`;
}

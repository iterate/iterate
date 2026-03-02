export function parseGitHubFullName(fullName: string) {
  const [owner, name] = fullName.split("/");
  if (!owner || !name) return null;
  return { owner, name };
}

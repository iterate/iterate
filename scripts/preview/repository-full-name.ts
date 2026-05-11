export function splitRepositoryFullName(repositoryFullName: string) {
  const parts = repositoryFullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Expected repository full name to look like owner/repo. Got: ${repositoryFullName}`,
    );
  }

  return parts as [string, string];
}

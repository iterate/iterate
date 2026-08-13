export function parseChatSlashCommand(input: string): { kind: "use-my-computer" } | null {
  return input.trim().toLowerCase() === "/use-my-computer" ? { kind: "use-my-computer" } : null;
}

export function computerCapabilityName(username: string): string {
  const words = username.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (!words.length) throw new Error("The operating-system username has no letters or digits.");

  const camelName = words
    .map((word, index) => {
      const lower = word.toLowerCase();
      return index === 0 ? lower : `${lower[0]!.toUpperCase()}${lower.slice(1)}`;
    })
    .join("");
  const validStart = /^[a-zA-Z]/.test(camelName) ? camelName : `user${camelName}`;
  return `${validStart}Computer`;
}

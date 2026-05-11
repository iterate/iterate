export function generateDefaultAvatar(email: string): string {
  const normalized = email.trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash << 5) - hash + normalized.charCodeAt(i);
    hash |= 0;
  }
  return `https://api.dicebear.com/9.x/notionists/svg?seed=${Math.abs(hash).toString(36)}`;
}

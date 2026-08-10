export function shouldShowActiveDesign(designUpdatedAt: string | undefined, latestMessageAt: string | undefined): boolean {
  if (!designUpdatedAt) return false;
  if (!latestMessageAt) return true;
  return Date.parse(designUpdatedAt) >= Date.parse(latestMessageAt);
}

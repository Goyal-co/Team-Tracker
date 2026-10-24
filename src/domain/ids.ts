export function nextId(prefix: string, existing: string[], width: number): string {
  let max = 0;
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  for (const value of existing) {
    const match = pattern.exec(value);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}${String(max + 1).padStart(width, "0")}`;
}

export function splitIds(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function joinIds(ids: string[]): string {
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean))).join(",");
}

export function isPlaceholderEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith("@goyal.demo");
}

export function cleanText(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

export function parseManagerEmails(csv: string): Set<string> {
  return new Set(
    (csv ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

export function isManagerEmail(email: string, set: Set<string>): boolean {
  return set.has((email ?? "").trim().toLowerCase());
}

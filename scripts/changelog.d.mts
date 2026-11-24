export function readReleaseNotes(
  markdown: string,
  version: string,
): { date: string; changes: string[] } | undefined;

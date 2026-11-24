/** Read the reviewed date and single-line changes for a stable package version. */
export function readReleaseNotes(markdown, version) {
  if (
    typeof markdown !== 'string' ||
    typeof version !== 'string' ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)
  )
    return undefined;

  const heading = `## [${version}]`;
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0 || lines.slice(start + 1).some((line) => line.startsWith(heading))) return;

  const date = /^ - (\d{4}-\d{2}-\d{2})$/.exec(lines[start].slice(heading.length).trimEnd())?.[1];
  const time = Date.parse(date ?? '');
  if (!date || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) return;

  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  const entries = lines.slice(start + 1, end < 0 ? undefined : end).filter((line) => line.trim());
  if (!entries.length || entries.some((line) => !/^- \S/.test(line))) return;
  return { date, changes: entries.map((line) => line.slice(2).trimEnd()) };
}

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const rootDocuments = new Set(['AGENTS.md', 'README.md', 'SECURITY.md', 'CLAUDE.md', 'GEMINI.md']);
const documentationFile = /\.(?:md|png|jpe?g|gif|webp|avif|svg|ico)$/i;

// Keep unknown paths conservative. Configuration, scripts and renamed runtime
// files must receive runtime checks even when the replacement is documentation.
export function isDocsOnly(paths) {
  return (
    Array.isArray(paths) &&
    paths.length > 0 &&
    paths.every(
      (path) =>
        typeof path === 'string' &&
        !/[\\\x00-\x1f\x7f]/.test(path) &&
        !path.split('/').some((part) => part === '' || part === '.' || part === '..') &&
        (rootDocuments.has(path) || (path.startsWith('docs/') && documentationFile.test(path))),
    )
  );
}

export function docsOnlyDiff(base, head, cwd = process.cwd()) {
  if (![base, head].every((revision) => /^[0-9a-f]{40}$/.test(revision ?? ''))) return false;
  try {
    // No rename detection: both an old runtime path and its new documentation
    // path are classified, including deletions. NUL separation preserves names.
    const output = execFileSync(
      'git',
      ['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', base, head, '--'],
      { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return isDocsOnly(output.endsWith('\0') ? output.slice(0, -1).split('\0') : []);
  } catch {
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  console.log(`docs_only=${args.length === 2 && docsOnlyDiff(args[0], args[1])}`);
}

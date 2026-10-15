import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The validator deliberately needs no installed dependencies in documentation-only CI.
// @ts-expect-error Plain Node entrypoint has no TypeScript declaration file.
import { checkDocs } from '../scripts/check-docs.mjs';

const directories: string[] = [];
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'jellyport-docs-test-'));
  directories.push(root);
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), contents);
  }
  return root;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it('checks local inline/image/reference links, encoded paths and duplicate heading anchors', () => {
  const root = fixture({
    'README.md':
      '[Guide](docs/guide.md#saved-snapshots--0120)\n[Again](docs/guide.md#repeat-1)\n![Image](docs/demo.jpg)\n[Reference]: <docs/with%20space.md>\n[Remote](https://example.invalid/no-request)',
    'docs/guide.md': '# Saved snapshots — 0.12.0\n## Repeat\n## Repeat\n',
    'docs/with space.md': '# Other',
    'docs/demo.jpg': 'synthetic image placeholder',
  });
  expect(checkDocs(root, ['README.md', 'docs/guide.md'])).toEqual([]);
});

it('reports broken files and heading anchors with locations', () => {
  const root = fixture({ 'README.md': '[Missing](missing.md)\n[Anchor](#missing)\n# Present' });
  expect(checkDocs(root, ['README.md'])).toEqual([
    'README.md:1: invalid local link missing.md',
    'README.md:2: invalid local link #missing',
  ]);
});

it('ignores fenced examples and preserves source line numbers', () => {
  const root = fixture({
    'README.md':
      '```md\n[Example](not-real.md)\n```\n~~~\n[Example](also-not-real.md)\n~~~\n[Broken](broken.md)',
  });
  expect(checkDocs(root, ['README.md'])).toEqual(['README.md:7: invalid local link broken.md']);
});

it('refuses absolute, escaping, malformed and unsupported local URLs', () => {
  const root = fixture({
    'README.md': '[A](/private.md)\n[B](../outside.md)\n[C](%ZZ)\n[D](file:///private.md)',
  });
  expect(checkDocs(root, ['README.md'])).toHaveLength(4);
});

it('refuses links and Markdown sources that resolve through an outside symlink', () => {
  const root = fixture({ 'README.md': '[Outside](outside.md)' });
  const outside = fixture({ 'private.md': '# Private' });
  symlinkSync(join(outside, 'private.md'), join(root, 'outside.md'));
  expect(checkDocs(root, ['README.md', 'outside.md'])).toHaveLength(2);
});

it('accepts same-document and explicit anchors but rejects directories', () => {
  const root = fixture({
    'README.md': '# Main\n[Here](#main)\n<a id="custom"></a>\n[Custom](#custom)\n[Directory](docs)',
    'docs/guide.md': '# Guide',
  });
  expect(checkDocs(root, ['README.md'])).toEqual(['README.md:5: invalid local link docs']);
});

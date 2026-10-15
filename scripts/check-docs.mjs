import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function prose(source) {
  let fence;
  return source.split(/\r?\n/).map((line) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
      return '';
    }
    return fence ? '' : line;
  });
}

function anchors(source) {
  const result = new Set(),
    counts = new Map();
  for (const line of prose(source)) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const slug = heading[1]
        .replace(/<[^>]*>/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
        .replace(/\s/g, '-');
      const count = counts.get(slug) ?? 0;
      counts.set(slug, count + 1);
      result.add(count ? `${slug}-${count}` : slug);
    }
    for (const match of line.matchAll(/<a\s+(?:id|name)=["']([^"']+)["']/g)) result.add(match[1]);
  }
  return result;
}

/** Checks repository inline/reference links and ATX heading anchors without network access. */
export function checkDocs(root, files) {
  root = realpathSync(root);
  const errors = [],
    cachedAnchors = new Map();
  const inside = (path) => path === root || path.startsWith(root + sep);
  for (const file of files) {
    const path = resolve(root, file);
    let source;
    try {
      if (!inside(path) || !inside(realpathSync(path))) throw new Error('outside repository');
      source = readFileSync(path, 'utf8');
    } catch {
      errors.push(`${file}: Markdown source is missing or outside the repository.`);
      continue;
    }
    for (const [index, line] of prose(source).entries()) {
      const links = [
        ...line.matchAll(/!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g),
      ].map((match) => match[1] ?? match[2]);
      const reference = line.match(/^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/);
      if (reference) links.push(reference[1] ?? reference[2]);
      for (const link of links) {
        if (/^(?:https?:|mailto:|\/\/)/i.test(link)) continue;
        const label = `${file}:${index + 1}`;
        try {
          const hash = link.indexOf('#');
          const target = decodeURIComponent((hash < 0 ? link : link.slice(0, hash)).split('?')[0]);
          const fragment = hash < 0 ? '' : decodeURIComponent(link.slice(hash + 1));
          if (isAbsolute(target) || /^[a-z][a-z\d+.-]*:/i.test(target))
            throw new Error('invalid path');
          const destination = target ? resolve(dirname(path), target) : path;
          if (!inside(destination) || !inside(realpathSync(destination)))
            throw new Error('invalid path');
          if (!statSync(destination).isFile()) throw new Error('missing file');
          if (fragment && destination.endsWith('.md')) {
            if (!cachedAnchors.has(destination))
              cachedAnchors.set(destination, anchors(readFileSync(destination, 'utf8')));
            if (!cachedAnchors.get(destination).has(fragment)) throw new Error('missing anchor');
          }
        } catch {
          errors.push(`${label}: invalid local link ${link}`);
        }
      }
    }
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = realpathSync(
    execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
  );
  const files =
    process.argv.length > 2
      ? process.argv.slice(2).map((file) => relative(root, resolve(file)))
      : execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', cwd: root })
          .split('\0')
          .filter((file) => file.endsWith('.md'));
  const errors = checkDocs(root, files);
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else
    console.log(
      `Documentation links and paths passed (${files.length} Markdown files; no remote requests).`,
    );
}

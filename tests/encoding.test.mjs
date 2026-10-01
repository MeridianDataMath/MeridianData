// The site's text files are UTF-8. A file read as Windows-1252 and saved again as UTF-8 (PowerShell 5.1's Get-Content
// without -Encoding does that) turns every non-ASCII character into two or three: the sort arrow "▾" became
// a-circumflex, an en dash and three-quarters on every sorted column (2026-09-30). This catches such a file before it
// deploys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root } from './_load.mjs';

const files = (dir, ext) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name), ext) : ext.test(e.name) ? [path.join(dir, e.name)] : []));
// a UTF-8 lead byte read as Windows-1252 (Â Ã â …) followed by a continuation byte read the same way
const MOJIBAKE = /[Â-Ãâ-ï][\u0080-¿ŒœŠšŸŽžƒˆ˜–—‘-„†-•…‰‹›€™]/;

test('no double-encoded UTF-8 in the site\'s text files', () => {
  const list = [...files('css', /\.css$/), ...files('js', /\.m?js$/), ...files('scripts', /\.m?js$/), ...files('tests', /\.mjs$/), 'index.html', '_headers', 'README.md'];
  const bad = [];
  for (const f of list) {
    const buf = fs.readFileSync(path.join(root, f));
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bad.push(f + ': starts with a byte-order mark');
    buf.toString('utf8').split('\n').forEach((l, i) => { if (MOJIBAKE.test(l)) bad.push(`${f}:${i + 1}: ${l.trim().slice(0, 80)}`); });
  }
  assert.deepEqual(bad, []);
});

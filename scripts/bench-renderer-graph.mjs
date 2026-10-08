#!/usr/bin/env node
// Measure the actual built HTML's static JavaScript graph, including shared chunks.
// esbuild only parses each emitted file here; it does not rebundle or estimate sizes.
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { build } from 'esbuild';
const directory = resolve(process.argv[2] ?? 'out/renderer');
const html = await readFile(join(directory, 'index.html'), 'utf8');
const entries = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/gu)].map(match => resolve(directory, match[1]));
assert.ok(entries.length > 0, 'built HTML must name an entry script');
const files = new Map();
async function visit(path) {
  if (files.has(path)) return;
  assert.ok(relative(directory, path) && !relative(directory, path).startsWith('..'), 'static imports must stay inside built renderer');
  const source = await readFile(path);
  files.set(path, source.length);
  const parsed = await build({entryPoints:[path], bundle:false, write:false, metafile:true, format:'esm', platform:'browser', logLevel:'silent'});
  for (const output of Object.values(parsed.metafile.outputs)) for (const imported of output.imports) {
    if (imported.kind === 'import-statement') {
      assert.ok(imported.path.startsWith('.'), `unexpected external renderer import: ${imported.path}`);
      await visit(resolve(dirname(path), imported.path));
    }
  }
}
for (const entry of entries) await visit(entry);
const assets = join(directory, 'assets');
const jsFiles = (await readdir(assets)).filter(name => name.endsWith('.js'));
const totalBytes = (await Promise.all(jsFiles.map(name => stat(join(assets, name))))).reduce((sum, file) => sum + file.size, 0);
process.stdout.write(JSON.stringify({correctness:true, eager_js_bytes:[...files.values()].reduce((sum,size)=>sum+size,0), total_js_bytes:totalBytes,
  static_files:[...files].map(([path,bytes])=>({path:relative(directory,path),bytes})), all_chunks:jsFiles.length}, null, 2) + '\n');

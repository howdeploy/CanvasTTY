import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import electronPath from 'electron';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'ct-editor-'));
let child;
let server;
try {
  const fixture = await build({ entryPoints: [join(root, 'tests/fixtures/browser-editor-client.mjs')],
    bundle: true, write: false, platform: 'browser', nodePaths: process.env.NODE_PATH?.split(delimiter) });
  const html = '<!doctype html><meta charset="utf-8"><input aria-label="Plain" value="old"><textarea aria-label="Multiline">old</textarea><div contenteditable="true" role="textbox" aria-label="Rich">old</div><input aria-label="Readonly" value="protected" readonly><button>Not editable</button><div id="editor"></div><pre id="submitted"></pre><script src="/fixture.js"></script>';
  server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html; charset=utf-8');
    response.end(request.url === '/fixture.js' ? fixture.outputFiles[0].contents : html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const workerPath = join(directory, 'worker.cjs');
  await build({ entryPoints: [join(root, 'tests/fixtures/browser-editor-worker.mjs')],
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: workerPath });
  const args = [workerPath, '--user-data-dir=' + join(directory, 'profile'), '--disable-gpu'];
  if (process.platform === 'linux' && process.env.CI === 'true') args.push('--no-sandbox');
  const env = { ...process.env, CANVASTTY_EDITOR_FIXTURE_URL: 'http://127.0.0.1:' + server.address().port };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electronPath, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output = (output + data).slice(-128 * 1024); });
  child.stderr.on('data', data => { output = (output + data).slice(-128 * 1024); });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    process.stdout.write(output);
    assert.equal(code, 0, 'Editor smoke failed');
    assert.match(output, /CANVASTTY_EDITOR_SMOKE_OK/);
  } finally { clearTimeout(timer); }
} finally {
  if (child?.exitCode === null) child.kill();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ACPAdapter } from '../src/main/services/ACPAdapter.ts';

test('ACP disposal stops its owned POSIX tool group even when the leader exits and a tool ignores SIGTERM', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'canvastty-acp-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'escaped-tool');
  const script = join(root, 'fake-acp.mjs');
  const tool = `process.on('SIGTERM', () => {}); process.stdout.write('ready'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'still running'), 1600); setTimeout(() => process.exit(), 1900);`;
  await writeFile(script, `import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
createInterface({input:process.stdin}).on('line', line => { const f=JSON.parse(line);
if(f.method==='initialize') send(f.id,{protocolVersion:1,agentCapabilities:{}});
if(f.method==='session/new') {
  const child = spawn(process.execPath,['-e',${JSON.stringify(tool)}],{stdio:['ignore','pipe','ignore']});
  child.stdout.once('data', () => send(f.id,{sessionId:'fixture'}));
}});`);
  let exits = 0;
  const adapter = new ACPAdapter({ command: process.execPath, args: [script], cwd: root, environment: {}, provider: 'cursor', checkModel() {}, onSessionId() {}, onState() {}, onText() {}, onExit() { exits++; } });
  t.after(() => adapter.dispose());
  await adapter.ready; adapter.dispose(); await adapter.stopped;
  assert.equal(exits, 1);
  await new Promise(resolve => setTimeout(resolve, 1700));
  assert.equal(await stat(marker).then(() => true, () => false), false, 'Tool outlived its owning ACP group');
});

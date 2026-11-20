import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAccessService } from '../src/main/services/FileAccessService.ts';
import { classifyFileRead } from '../src/renderer/src/features/files/fileViewer.ts';

test('media preview streams ranges and seeks without reading a binary movie into IPC', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-media-'));
  try {
    const file = join(dir, 'space # film.MP4');
    await writeFile(file, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    const service = new FileAccessService({ resolveSessionCwd: () => dir });
    const root = service.registerFolderRoot(dir);
    const result = await service.read(root.rootId, 'space # film.MP4');
    assert.equal(result.kind, 'media');
    assert.equal(result.mediaType, 'video/mp4');
    assert.equal('content' in result, false);
    assert.equal(classifyFileRead(result).kind, 'media');
    const response = await service.protocolResponse(new Request(result.url, { headers: { Range: 'bytes=2-4' } }));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 2-4/8');
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [2, 3, 4]);
    const head = await service.protocolResponse(new Request(result.url, { method: 'HEAD' }));
    assert.equal(head.headers.get('content-length'), '8');
    assert.equal(await head.text(), '');
    const invalid = await service.protocolResponse(new Request(result.url, { headers: { Range: 'bytes=99-100' } }));
    assert.equal(invalid.status, 416);
    service.releaseRoot(root.rootId);
    assert.equal((await service.protocolResponse(new Request(result.url))).status, 404);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('media URL cannot escape a registered root or serve arbitrary HTML', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-media-boundary-'));
  try {
    await writeFile(join(dir, 'outside.mp4'), 'secret');
    await writeFile(join(dir, 'page.html'), '<script>bad()</script>');
    await writeFile(join(dir, 'sound.mp3'), Buffer.from([0,1,2]));
    const service = new FileAccessService({ resolveSessionCwd: () => dir });
    const root = service.registerFolderRoot(dir);
    const sound = await service.read(root.rootId, 'sound.mp3');
    assert.equal(sound.kind, 'media');
    assert.equal(sound.mediaType, 'audio/mpeg');
    assert.equal((await service.protocolResponse(new Request(`canvastty-preview://${root.rootId}/page.html`))).status, 415);
    assert.equal((await service.protocolResponse(new Request(`canvastty-preview://${root.rootId}/..%2Foutside.mp4`))).status, 404);
    await assert.rejects(() => service.resolvePath(root.rootId, '../outside.mp4'), /outside/);
    if (process.platform !== 'win32') {
      await symlink(join(dir, 'outside.mp4'), join(dir, 'link.mp4'));
      // A contained link is allowed by the canonical resolver; the descriptor still matches.
      assert.equal(await service.resolvePath(root.rootId, 'link.mp4'), await realpath(join(dir, 'outside.mp4')));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

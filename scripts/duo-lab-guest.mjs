// Disposable second-machine acceptance client. Invitation arrives on stdin and is never printed.
import { createInterface } from 'node:readline';
import { CanvasDuoService } from './duo-service.mjs';
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
const service = new CanvasDuoService({ listMetadata: () => [], geometry() { throw Error('Guest has no local terminals'); }, readBuffer() { throw Error('Guest has no local terminals'); }, inputChecked: () => false });
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
try {
  const { invite, cardId } = JSON.parse((await lines.next()).value);
  const reply = await service.command({ action: 'join', invite });
  if (reply.snapshot.cards.length !== 1 || reply.snapshot.cards[0].id !== cardId || JSON.stringify(reply.snapshot).includes('DO_NOT_SHARE_CANVAS_PRIVATE')) throw Error('Selected-card boundary failed');
  let denied = false;
  try { await service.command({ action: 'input', cardId, text: 'UNAUTHORIZED\r' }); }
  catch { denied = true; }
  if (!denied) throw Error('Read-only guest could send input');
  await service.command({ action: 'comment', cardId, text: 'LAN guest verified on Ubuntu' });
  await service.command({ action: 'cursor', cardId, x: .3, y: .4 });
  out({ phase: 'joined', selectedOnly: true, inputDenied: true });
  const next = await lines.next();
  if (next.done || JSON.parse(next.value).grant !== true) throw Error('No explicit host input grant');
  await service.command({ action: 'input', cardId, text: "printf '\\104\\125\\117\\055\\114\\101\\116\\055\\117\\113\\n'\r" });
  let received = false;
  for (let i = 0; i < 30; i++) {
    const view = await service.command({ action: 'snapshot' });
    if (view.snapshot.cards[0].text.includes('DUO-LAN-OK')) { received = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!received) throw Error('Real terminal command output did not return over LAN');
  out({ phase: 'complete', terminalRoundtrip: true, comments: true, cursors: true });
} catch (error) { out({ phase: 'failed', error: error.message }); process.exitCode = 1; }
finally { await service.stop(); process.exit(); }

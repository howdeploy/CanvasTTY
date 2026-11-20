// Original vector artwork, rasterized by Chromium. No network, fonts or AI images.
// Run with Node; the isolated Electron child only renders this source's SVGs.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const electron = require('electron');
const root = resolve(import.meta.dirname, '..');
// Archived experiments must not overwrite the approved release catalog.
const output = join(root, '../artifacts/retired-live-terminal-presets');
const preview = join(root, '../artifacts/live-terminal-presets');
const count = 16, duration = 125;
const aperture = { left: 8, right: 8, top: 17, bottom: 13 };
const themes = [
  { key: 'aurora', name: 'Aurora · Live', id: 'pixel:92020000-0000-4000-8000-000000000001', ink: '#0b182b', edge: '#284b69', color: '#64e5dd', second: '#9a8eff' },
  { key: 'ember', name: 'Ember · Live', id: 'pixel:92020000-0000-4000-8000-000000000002', ink: '#211c1b', edge: '#5b4b3d', color: '#ffb65a', second: '#ff725e' },
  { key: 'sakura', name: 'Sakura · Live', id: 'pixel:92020000-0000-4000-8000-000000000003', ink: '#231c32', edge: '#62516d', color: '#eeb4dc', second: '#b59be9' }
];
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function chunk(type, data) {
  const tag = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  let value = 0xffffffff;
  for (const byte of Buffer.concat([tag, data])) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  crc.writeUInt32BE((value ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, tag, data, crc]);
}
function chunks(png) {
  const result = [];
  for (let pos = 8; pos < png.length;) {
    const size = png.readUInt32BE(pos), type = png.toString('ascii', pos + 4, pos + 8);
    result.push([type, png.subarray(pos + 8, pos + 8 + size)]);
    pos += size + 12;
  }
  return result;
}
function apng(frames) {
  const parsed = frames.map(chunks), header = parsed[0].find(([type]) => type === 'IHDR')[1];
  const control = Buffer.alloc(8); control.writeUInt32BE(frames.length);
  const parts = [frames[0].subarray(0, 8), chunk('IHDR', header), chunk('acTL', control)];
  let sequence = 0;
  for (let i = 0; i < frames.length; i++) {
    const fc = Buffer.alloc(26);
    fc.writeUInt32BE(sequence++, 0); header.copy(fc, 4, 0, 8);
    fc.writeUInt16BE(duration, 20); fc.writeUInt16BE(1000, 22);
    // Full transparent frame replacement. No trails or dependence on previous state.
    fc[24] = 0; fc[25] = 0;
    parts.push(chunk('fcTL', fc));
    const image = Buffer.concat(parsed[i].filter(([type]) => type === 'IDAT').map(([, data]) => data));
    if (i === 0) parts.push(chunk('IDAT', image));
    else { const seq = Buffer.alloc(4); seq.writeUInt32BE(sequence++); parts.push(chunk('fdAT', Buffer.concat([seq, image]))); }
  }
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
function zip(entries) {
  const body = [], directory = []; let offset = 0;
  for (const [name, bytes] of entries) {
    const file = Buffer.from(name);
    let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30 + file.length);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    // Store already-compressed APNGs; reproducible archive, zero timestamps.
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(file.length, 26); file.copy(local, 30);
    body.push(local, bytes);
    const central = Buffer.alloc(46 + file.length);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(file.length, 28); central.writeUInt32LE(offset, 42); file.copy(central, 46);
    directory.push(central); offset += local.length + bytes.length;
  }
  const table = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(table.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, table, end]);
}
function frame(theme, detail, state, index) {
  const t = index / count, phase = t * Math.PI * 2;
  const level = ['minimal', 'detailed', 'master'].indexOf(detail);
  const accent = state === 'completed' ? '#a6e6bd' : theme.color;
  const active = state === 'working';
  const elements = [];
  // Geometry stays identical in all 27 variants; the aperture is explicitly masked last.
  elements.push(`<path d="M72 40H1464L1496 72V952L1464 984H72L40 952V72Z" fill="${theme.ink}" stroke="${theme.edge}" stroke-width="3"/>`);
  elements.push(`<path d="M84 56H1452L1480 84V940L1452 968H84L56 940V84Z" fill="none" stroke="${accent}" stroke-opacity=".28" stroke-width="2"/>`);
  elements.push(`<rect x="113" y="164" width="1310" height="738" rx="12" fill="none" stroke="${accent}" stroke-opacity=".5" stroke-width="2"/>`);
  // Clear native-control plaque in the top right, and no baked labels or terminal screen.
  elements.push(`<path d="M1210 72H1438L1456 90V144H1210Z" fill="#0d111a" fill-opacity=".5" stroke="${theme.edge}"/>`);
  if (theme.key === 'aurora') {
    for (let j = 0; j < 3 + level * 2; j++) {
      const y = 90 + j * 7, amplitude = 9 + level * 2;
      let d = '';
      for (let x = 150; x <= 1160; x += 8) {
        const yy = y + Math.sin(x / 145 + phase * (active ? 2 : 1) + j * .55) * amplitude;
        d += `${x === 150 ? 'M' : 'L'}${x},${yy.toFixed(2)} `;
      }
      elements.push(`<path d="${d}" fill="none" stroke="${j % 2 ? theme.second : accent}" stroke-opacity="${.7 - j * .06}" stroke-width="${level === 2 ? 3 : 2}"/>`);
    }
    for (let j = 0; j < 6 + level * 4; j++) {
      const x = 168 + j * (1160 / (6 + level * 4)), y = 938 + Math.sin(phase + j) * 8;
      elements.push(`<circle cx="${x}" cy="${y}" r="${active ? 3 : 2}" fill="${j % 2 ? theme.second : accent}" opacity=".8"/>`);
    }
  } else if (theme.key === 'ember') {
    for (let x = 164; x < 1150; x += 34) {
      const light = active ? ((x / 34 + index) % 7 < 3 ? .95 : .2) : state === 'completed' ? .85 : .3;
      elements.push(`<path d="M${x} 91l15-16h10l-15 16Z" fill="${accent}" opacity="${light}"/>`);
    }
    for (const x of [78, 1458]) for (const y of [125, 930]) {
      elements.push(`<circle cx="${x}" cy="${y}" r="17" fill="#11141a" stroke="${theme.edge}" stroke-width="3"/>`);
      elements.push(`<path d="M${x - 10} ${y}h20M${x} ${y - 10}v20" stroke="${accent}" opacity=".6" transform="rotate(${index * 360 / count},${x},${y})"/>`);
    }
    if (level) for (let side = 0; side < 2; side++) for (let j = 0; j < 7 + level * 3; j++) {
      const x = side ? 1458 : 78, y = 245 + j * 47;
      elements.push(`<path d="M${x - 10} ${y}h20v12h-20Z" fill="${theme.edge}"/><path d="M${x - 7} ${y + 3}h14v6h-14Z" fill="${accent}" opacity="${.3 + .25 * (1 + Math.sin(phase + j))}"/>`);
    }
    elements.push(`<path d="M165 944h240l20-20h300l20 20h620" fill="none" stroke="${accent}" stroke-opacity=".6" stroke-width="3"/>`);
  } else {
    for (const side of [0, 1]) {
      const transform = side ? 'translate(1536 0) scale(-1 1)' : '';
      elements.push(`<g transform="${transform}"><path d="M70 887Q112 650 73 465Q52 282 166 92M82 435Q108 370 102 309M88 610Q57 560 59 526" fill="none" stroke="${theme.edge}" stroke-width="${level ? 7 : 4}" stroke-linecap="round"/>`);
      const flowers = [[149,110],[112,170],[87,246],[101,310],[73,410],[84,555],[70,677],[80,805]];
      for (let j = 0; j < (level === 0 ? 3 : level === 1 ? 6 : 8); j++) {
        const [x,y] = flowers[j], r = level === 2 ? 8 : 6;
        for (let p = 0; p < 5; p++) {
          const a = p * Math.PI * 2 / 5, pulse = .72 + .12 * Math.sin(phase + j);
          elements.push(`<ellipse cx="${x + Math.cos(a)*r}" cy="${y + Math.sin(a)*r}" rx="${r}" ry="${r*.6}" fill="${accent}" opacity="${pulse}" transform="rotate(${p*72},${x + Math.cos(a)*r},${y + Math.sin(a)*r})"/>`);
        }
        elements.push(`<circle cx="${x}" cy="${y}" r="3" fill="#ffe4c7"/>`);
      }
      elements.push('</g>');
    }
    for (let j = 0; j < 5 + level * 3; j++) {
      const x = 200 + j * (1080 / (5 + level * 3)), y = 104 + Math.sin(phase + j * .9) * 19;
      elements.push(`<ellipse cx="${x}" cy="${y}" rx="${active ? 8 : 5}" ry="3" fill="${j % 2 ? theme.second : accent}" opacity=".65" transform="rotate(${index * 360/count + j*40},${x},${y})"/>`);
    }
  }
  // Broad, unmistakable state vocabulary in addition to palette differences.
  if (active) {
    elements.push(`<rect x="556" y="932" width="424" height="8" rx="4" fill="${theme.edge}"/>`);
    const x = 556 + ((index / count) * 424);
    elements.push(`<path d="M${x} 936h${Math.min(72, 980-x)}" stroke="${accent}" stroke-width="8" stroke-linecap="round"/>`);
  } else if (state === 'completed') {
    for (const x of [666, 754, 842]) elements.push(`<path d="M${x} 927l11 11 23-23" fill="none" stroke="${accent}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`);
  } else {
    elements.push(`<path d="M650 936h236" stroke="${accent}" stroke-width="3" stroke-opacity="${.45 + .12*Math.sin(phase)}"/>`);
  }
  if (level === 2) for (const x of [250, 1090]) elements.push(`<path d="M${x} 956l20-10h156l20 10M${x+40} 962h116" fill="none" stroke="${theme.second}" opacity=".65" stroke-width="2"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="1024"><defs><mask id="safe"><rect width="1536" height="1024" fill="white"/><rect x="115" y="166" width="1306" height="733" fill="black"/></mask></defs><g mask="url(#safe)">${elements.join('')}</g></svg>`;
}
function background(theme, index) {
  const phase = index / count * Math.PI * 2;
  const stars = Array.from({ length: 32 }, (_, j) => `<circle cx="${(j * 131 + 41) % 768}" cy="${(j * 71 + 19) % 512}" r="${j % 5 === 0 ? 1.7 : 1}" fill="${theme.color}" opacity="${.18 + .08 * Math.sin(phase + j)}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="512"><defs><radialGradient id="g"><stop stop-color="${theme.edge}" stop-opacity=".32"/><stop offset="1" stop-color="${theme.ink}" stop-opacity="0"/></radialGradient></defs><rect width="768" height="512" fill="${theme.ink}"/><ellipse cx="${384 + Math.sin(phase)*24}" cy="220" rx="440" ry="260" fill="url(#g)"/>${stars}<path d="M0 468Q220 ${410+Math.sin(phase)*8} 400 460T768 440" fill="none" stroke="${theme.color}" opacity=".1"/></svg>`;
}
if (typeof electron === 'string') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electron, [import.meta.filename], { env, stdio: 'inherit' });
  process.exit(result.status ?? 1);
} else {
  void generate();
}
async function generate() {
  await electron.app.whenReady();
  const window = new electron.BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await mkdir(output, { recursive: true }); await mkdir(preview, { recursive: true });
    await window.loadURL('data:text/html,<canvas id="art"></canvas>');
    const render = async svg => Buffer.from(await window.webContents.executeJavaScript(`(async()=>{const i=new Image();i.src='data:image/svg+xml;base64,'+${JSON.stringify(Buffer.from(svg).toString('base64'))};await i.decode();const c=document.getElementById('art');c.width=i.width;c.height=i.height;const x=c.getContext('2d');x.clearRect(0,0,c.width,c.height);x.drawImage(i,0,0);return c.toDataURL('image/png').split(',')[1]})()`), 'base64');
    const thumbs = [];
    for (const theme of themes) {
      const entries = [];
      for (const detail of ['minimal','detailed','master']) for (const state of ['idle','working','completed']) {
        const frames = [];
        for (let i = 0; i < count; i++) frames.push(await render(frame(theme, detail, state, i)));
        entries.push([`${detail}_${state}.png`, apng(frames)]);
        thumbs.push({ theme, detail, state, png: frames[0] });
      }
      const frames = []; for (let i = 0; i < count; i++) frames.push(await render(background(theme, i)));
      entries.push(['background.png', apng(frames)]);
      const bytes = zip(entries); await writeFile(join(output, `${theme.key}.zip`), bytes);
      console.log(`${theme.name}: ${bytes.length} bytes; 9 animated frames + live wallpaper`);
    }
    await writeFile(join(output, 'catalog.json'), JSON.stringify({ schemaVersion: 1, presets: themes.map(({ key, name, id }) => ({ id, name, archive: `${key}.zip`, apertures: { minimal: aperture, detailed: aperture, master: aperture } })) }, null, 2) + '\n');
    const cells = thumbs.map(({ theme, detail, state, png }, i) => {
      const x = (i % 3) * 512, y = Math.floor(i / 3) * 374;
      return `<g transform="translate(${x},${y})"><rect x="40" y="58" width="432" height="265" rx="9" fill="#10151e"/><image width="512" height="341.33" href="data:image/png;base64,${png.toString('base64')}"/><text x="54" y="102" fill="#cbd7e6" font-family="monospace" font-size="12">$ canvas • terminal preview</text><text x="54" y="128" fill="#7fa898" font-family="monospace" font-size="11">Ready for your next idea.</text><text x="22" y="362" fill="#bac5d7" font-family="sans-serif" font-size="14">${theme.name} / ${detail} / ${state}</text></g>`;
    }).join('');
    const sheet = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1536" height="3366"><rect width="1536" height="3366" fill="#10131b"/>${cells}</svg>`;
    await writeFile(join(preview, 'contact-sheet.png'), await render(sheet));
    await writeFile(join(preview, 'apertures.json'), JSON.stringify({ minimal: aperture, detailed: aperture, master: aperture }, null, 2));
    await writeFile(join(preview, 'source.json'), JSON.stringify({ generator: 'scripts/generate-live-terminal-presets.mjs', originalArtwork: true, size: [1536,1024], frames: count, fps: 1000/duration, loopSeconds: count*duration/1000, themes: themes.map(t => t.key) }, null, 2));
    electron.app.exit(0);
  } catch (error) { console.error(error); electron.app.exit(1); }
}

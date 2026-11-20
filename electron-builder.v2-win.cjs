// Isolated unsigned Windows test bundle, built on SSD; do not touch installed applications.
const fs = require('node:fs');
const path = require('node:path');
fs.accessSync(path.join(__dirname, 'build/windows-agent-pipe-host/canvastty-windows-agent-pipe-host.exe'));
const base = require('./electron-builder.v2.cjs');
const { electronDist, ...config } = base;
module.exports = { ...config, directories: { ...config.directories, output: 'release/v2-home-alpha7-win' },
  win: { ...config.win, signAndEditExecutable: false, target: ['dir'] } };

// Separate local alpha. Never publish or replace the installed release.
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');
const base = yaml.parse(fs.readFileSync(path.join(__dirname, 'electron-builder.yml'), 'utf8'));
module.exports = {
  ...base,
  // Local builds package the pinned runtime already verified by npm's installer.
  electronDist: path.join(__dirname, 'node_modules/electron/dist'),
  appId: 'io.github.howdeploy.canvastty.v2-alpha',
  productName: 'CanvasTTY 2.0 Alpha',
  protocols: [{name:'Canvas Duo invitation',schemes:['canvasduo']}],
  extraMetadata: { name: 'canvastty-v2-alpha', productName: 'CanvasTTY 2.0 Alpha', version: '2.0.0-alpha.7' },
  directories: { ...base.directories, output: 'release/v2-home-alpha7' },
  extraResources: [...base.extraResources,
    { from: 'examples/plugins/file-explorer', to: 'bundled-plugins/file-explorer' },
    { from: 'design-engine', to: 'design-engine', filter: ['**/*', '!**/.git/**', '!**/__pycache__/**', '!CanvasTTY_Agent_Theme_Kit_v1.zip'] }
  ],
  afterPack: null,
  publish: null,
  npmRebuild: false,
  mac: { ...base.mac, extraFiles: [], target: ['dir'] }
};

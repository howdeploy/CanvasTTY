// Local SSD build; never publish or connect the lab app to the release updater.
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');
const base = yaml.parse(fs.readFileSync(path.join(__dirname, 'electron-builder.yml'), 'utf8'));
module.exports = {
  ...base,
  appId: 'io.github.howdeploy.canvastty.live-home-lab',
  productName: 'CanvasTTY Live Home Lab',
  extraMetadata: { name: 'canvastty-live-home-lab', productName: 'CanvasTTY Live Home Lab', version: '1.8.5-live-home.1' },
  directories: { ...base.directories, output: 'release/live-home' },
  afterPack: null,
  publish: null,
  npmRebuild: false, // Same Electron/ABI as the locally rebuilt, copied dependencies.
  mac: { ...base.mac, extraFiles: [], target: ['dir'] }
};

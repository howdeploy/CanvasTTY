// Keep the previously accepted alpha7 bundle intact during preset acceptance.
const base = require('./electron-builder.v2.cjs');
module.exports = { ...base, directories: { ...base.directories, output: 'release/v2-live-terminal-presets' } };

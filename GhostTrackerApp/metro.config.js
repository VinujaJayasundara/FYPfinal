const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.assetExts.push('wasm');

// Shared pure-TypeScript core engine (CRDT, sync protocol) lives in ../GhostTracker/src
config.watchFolders = [path.resolve(__dirname, '../GhostTracker/src')];

module.exports = config;

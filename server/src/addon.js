// addon.js — assemble the addonInterface from the manifest + the three handlers.

const { addonBuilder } = require('stremio-addon-sdk');
const manifest = require('./manifest');
const { handleCatalog } = require('./catalogHandler');
const { handleMeta } = require('./metaHandler');
const { handleStream } = require('./streamHandler');

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(handleCatalog);
builder.defineMetaHandler(handleMeta);
builder.defineStreamHandler(handleStream);

module.exports = builder.getInterface();

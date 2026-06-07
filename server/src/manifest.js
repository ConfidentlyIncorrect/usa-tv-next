// manifest.js — combined addon manifest.
//
// Direction B: this is the canonical USA TV Next addon, now dynamic. It keeps the
// original id (community.usa-tv-next) and catalog id ("all") so existing installs and
// library entries continue to resolve, and it now owns ALL THREE resources for the
// `ustv` id space — catalog, meta (EPG-enriched), and stream. Because a single addon
// owns `ustv`, there is no longer a meta-resource collision between two addons (the
// root cause of descriptions disappearing on channel click).

const GENRES = [
    'Local', 'News', 'Sports', 'Entertainment',
    'Premium', 'Lifestyle', 'Kids', 'Documentaries',
    'Music', 'Latino',
];

const manifest = {
    id: 'community.usa-tv-next',
    version: '3.0.0',
    name: 'USA TV Next',
    description: 'USA live TV with an integrated Electronic Program Guide. Browse 293 channels with Now Playing / Up Next, full day schedules, search, and genre filtering — streams and guide served from a single addon, with multiple stream sources per channel for reliability.',
    logo: 'https://raw.githubusercontent.com/ConfidentlyIncorrect/usa-tv-next/main/public/logo.png',
    background: 'https://raw.githubusercontent.com/ConfidentlyIncorrect/usa-tv-next/main/public/background.jpg',

    catalogs: [
        {
            id: 'all',
            type: 'tv',
            name: 'USA TV Next',
            extra: [
                { name: 'genre', isRequired: false, options: GENRES },
                { name: 'search', isRequired: false },
                { name: 'skip', isRequired: false },
            ],
        },
    ],

    // All three resources are scoped to type "tv" and the "ustv" id prefix so this
    // single addon answers catalog, meta, and stream for every channel.
    resources: [
        'catalog',
        { name: 'meta', types: ['tv'], idPrefixes: ['ustv'] },
        { name: 'stream', types: ['tv'], idPrefixes: ['ustv'] },
    ],

    types: ['tv'],
    idPrefixes: ['ustv'],

    behaviorHints: {
        configurable: false,
        configurationRequired: false,
    },
};

module.exports = manifest;

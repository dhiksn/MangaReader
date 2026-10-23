const SoftkomikSource = require('./softkomik/SoftkomikSource');
const KomikuSource = require('./komiku/KomikuSource');
const HwagoSource = require('./hwago/HwagoSource');
const DoujindesuSource = require('./doujindesu/DoujindesuSource');
const ShinigamiSource = require('./shinigami/ShinigamiSource');

const sources = new Map();

/**
 * Register a scraper source.
 * @param {import('./BaseSource')} sourceInstance
 */
function registerSource(sourceInstance) {
  sources.set(sourceInstance.name.toLowerCase(), sourceInstance);
  if (typeof sourceInstance.getIcon === 'function') {
    sourceInstance.getIcon().catch(() => {});
  }
}

/**
 * Get a source by its name/id.
 * @param {string} name
 * @returns {import('./BaseSource')|undefined}
 */
function getSource(name) {
  return sources.get(name.toLowerCase());
}

/**
 * List all available registered sources with their website icons.
 */
function listSources() {
  return Array.from(sources.values()).map((s) => ({
    id: s.name,
    name: s.displayName,
    icon: s.icon || `${s.baseUrl}/favicon.ico`,
  }));
}

// Register default sources
registerSource(new SoftkomikSource());
registerSource(new KomikuSource());
registerSource(new HwagoSource());
registerSource(new DoujindesuSource());
registerSource(new ShinigamiSource());

module.exports = {
  registerSource,
  getSource,
  listSources,
};

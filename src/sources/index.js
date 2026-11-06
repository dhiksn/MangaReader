const SoftkomikSource = require('./softkomik/SoftkomikSource');
const KomikuSource = require('./komiku/KomikuSource');
const HwagoSource = require('./hwago/HwagoSource');
const DoujindesuSource = require('./doujindesu/DoujindesuSource');
const ShinigamiSource = require('./shinigami/ShinigamiSource');
const KiryuuSource = require('./kiryuu/KiryuuSource');
const KomiktapSource = require('./komiktap/KomiktapSource');
const WestmangaSource = require('./westmanga/WestmangaSource');
const KomikindoSource = require('./komikindo/KomikindoSource');
const ApkomikSource = require('./apkomik/ApkomikSource');
const BacakomikSource = require('./bacakomik/BacakomikSource');
const LumosSource = require('./lumos/LumosSource');
const PixhentaiSource = require('./pixhentai/PixhentaiSource');
const HolotoonSource = require('./holotoon/HolotoonSource');
const IkiruSource = require('./ikiru/IkiruSource');
const HentaicrotSource = require('./hentaicrot/HentaicrotSource');
const VoratoonSource = require('./voratoon/VoratoonSource');
const LuvyaaSource = require('./luvyaa/LuvyaaSource');

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
 * List all available registered sources with their website icons and supported sorts.
 */
function listSources() {
  return Array.from(sources.values()).map((s) => ({
    id: s.name,
    name: s.displayName,
    icon: s.icon || `${s.baseUrl}/favicon.ico`,
    sorts: typeof s.getSupportedSorts === 'function' ? s.getSupportedSorts() : [
      { id: 'latest', name: 'Terbaru' },
      { id: 'popular', name: 'Populer' },
    ],
  }));
}

// Register default sources
registerSource(new SoftkomikSource());
registerSource(new KomikuSource());
registerSource(new HwagoSource());
registerSource(new DoujindesuSource());
registerSource(new ShinigamiSource());
registerSource(new KiryuuSource());
registerSource(new KomiktapSource());
registerSource(new WestmangaSource());
registerSource(new KomikindoSource());
registerSource(new ApkomikSource());
registerSource(new BacakomikSource());
registerSource(new LumosSource());
registerSource(new PixhentaiSource());
registerSource(new HolotoonSource());
registerSource(new IkiruSource());
registerSource(new HentaicrotSource());
registerSource(new VoratoonSource());
registerSource(new LuvyaaSource());

module.exports = {
  registerSource,
  getSource,
  listSources,
};

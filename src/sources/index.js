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
const CrotpediaSource = require('./crotpedia/CrotpediaSource');
const MihentaiSource = require('./mihentai/MihentaiSource');
const MaidSource = require('./maid/MaidSource');
const AinzSource = require('./ainz/AinzSource');
const SoulScansSource = require('./soulscans/SoulScansSource');
const KomikstationSource = require('./komikstation/KomikstationSource');
const KomikindochSource = require('./komikindoch/KomikindochSource');
const SasangeyouSource = require('./sasangeyou/SasangeyouSource');
const CgbumSource = require('./cgbum/CgbumSource');
const IzanamiScansSource = require('./izanamiscans/IzanamiScansSource');
const MangaSusukuSource = require('./mangasusuku/MangaSusukuSource');
const KanzeninSource = require('./kanzenin/KanzeninSource');
const LepoytlSource = require('./lepoytl/LepoytlSource');
const YuriLabSource = require('./yurilab/YuriLabSource');
const NatsuSource = require('./natsu/NatsuSource');
const KomikRemajaSource = require('./komikremaja/KomikRemajaSource');
const ShiroDoujinSource = require('./shirodoujin/ShiroDoujinSource');

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
registerSource(new CrotpediaSource());
registerSource(new MihentaiSource());
registerSource(new MaidSource());
registerSource(new AinzSource());
registerSource(new SoulScansSource());
registerSource(new KomikstationSource());
registerSource(new KomikindochSource());
registerSource(new SasangeyouSource());
registerSource(new CgbumSource());
registerSource(new IzanamiScansSource());
registerSource(new MangaSusukuSource());
registerSource(new KanzeninSource());
registerSource(new LepoytlSource());
registerSource(new YuriLabSource());
registerSource(new NatsuSource());
registerSource(new KomikRemajaSource());
registerSource(new ShiroDoujinSource());

module.exports = {
  registerSource,
  getSource,
  listSources,
};

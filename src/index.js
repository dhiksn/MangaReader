require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const mangaRoutes = require('./routes/manga.routes');
const proxyRoutes = require('./routes/proxy.routes');
const { listSources } = require('./sources');
const { authorMiddleware, getAuthor } = require('./utils/responseHelper');
const { configureCors } = require('./middlewares/security');
const { notFoundHandler, errorHandler } = require('./middlewares/errorHandler');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy header behind reverse proxies (e.g. Nginx, Cloudflare)
app.set('trust proxy', 1);

// Pretty-print JSON responses
app.set('json spaces', 2);

// Security & Base Middlewares
app.use(configureCors());
app.use(express.json({ limit: '2mb' }));
app.use(authorMiddleware);
app.use(express.static(path.join(__dirname, '../public')));

// Chapter Test Web Reader Route
app.get('/reader', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/reader.html'));
});

// Documentation / Welcome route
app.get('/', (req, res) => {
  res.json({
    name: 'Manga Scraper REST API',
    author: getAuthor(),
    status: 'online',
    version: '1.2.0',
    availableSources: listSources(),
    endpoints: {
      sources: 'GET /api/sources',
      softkomik: {
        popular: 'GET /api/sources/softkomik/popular?page=1',
        latest: 'GET /api/sources/softkomik/latest?page=1&category=all|normal|sensitive|nsfw',
        search: 'GET /api/sources/softkomik/search?q=:query&page=1',
        genres: 'GET /api/sources/softkomik/genres',
        byGenre: 'GET /api/sources/softkomik/genres/:genre?page=1',
        types: 'GET /api/sources/softkomik/types',
        byType: 'GET /api/sources/softkomik/types/:type?page=1',
        details: 'GET /api/sources/softkomik/manga/:slug',
        chapter: 'GET /api/sources/softkomik/chapter/:slug/:chapter?cdn=cdn1|cdn2|cdn3',
      },
      komiku: {
        latest: 'GET /api/sources/komiku/latest?page=1',
        list: 'GET /api/sources/komiku/list?page=1&letter=:letter',
        popular: 'GET /api/sources/komiku/popular?page=1',
        search: 'GET /api/sources/komiku/search?q=:query&page=1',
        genres: 'GET /api/sources/komiku/genres',
        byGenre: 'GET /api/sources/komiku/genres/:genre?page=1',
        types: 'GET /api/sources/komiku/types',
        byType: 'GET /api/sources/komiku/types/:type?page=1',
        details: 'GET /api/sources/komiku/manga/:slug',
        chapter: 'GET /api/sources/komiku/chapter/:slug/:chapter',
      },
      hwago: {
        popular: 'GET /api/sources/hwago/popular?page=1',
        latest: 'GET /api/sources/hwago/latest?page=1',
        rating: 'GET /api/sources/hwago/rating?page=1',
        az: 'GET /api/sources/hwago/az?page=1',
        list: 'GET /api/sources/hwago/list?page=1&sort=latest|popular|rating|az&status=&type=&genre=',
        search: 'GET /api/sources/hwago/search?q=:query&page=1',
        genres: 'GET /api/sources/hwago/genres',
        byGenre: 'GET /api/sources/hwago/genres/:genre?page=1',
        types: 'GET /api/sources/hwago/types',
        byType: 'GET /api/sources/hwago/types/:type?page=1',
        details: 'GET /api/sources/hwago/manga/:slug',
        chapter: 'GET /api/sources/hwago/chapter/:slug/:chapter',
      },
      doujindesu: {
        popular: 'GET /api/sources/doujindesu/popular?page=1',
        latest: 'GET /api/sources/doujindesu/latest?page=1',
        rating: 'GET /api/sources/doujindesu/rating?page=1',
        az: 'GET /api/sources/doujindesu/az?page=1',
        search: 'GET /api/sources/doujindesu/search?q=:query&page=1',
        genres: 'GET /api/sources/doujindesu/genres',
        byGenre: 'GET /api/sources/doujindesu/genres/:genre?page=1',
        types: 'GET /api/sources/doujindesu/types',
        byType: 'GET /api/sources/doujindesu/types/:type?page=1',
        details: 'GET /api/sources/doujindesu/manga/:slug',
        chapter: 'GET /api/sources/doujindesu/chapter/:slug/:chapter',
      },
    },
  });
});

// Mount Routes
app.use('/api', mangaRoutes);
app.use('/api/proxy', proxyRoutes);

// 404 Handler for unmatched routes
app.use(notFoundHandler);

// Global Centralized Error Handler
app.use(errorHandler);

// Start Server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`===============================================`);
    console.log(` Manga Scraper API running on http://localhost:${PORT}`);
    console.log(` Active Sources: ${listSources().map((s) => s.id).join(', ')}`);
    console.log(`===============================================`);
  });
}

module.exports = app;

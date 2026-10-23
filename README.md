# Manga Scraper REST API (Node.js)

REST API modular untuk scraping dan menyajikan data manga, manhwa, dan manhua dari berbagai sumber/website manga (multi-source architecture).

---

## 🚀 Cara Menjalankan

Masuk ke folder `manga-api`:

```bash
cd manga-api
npm install
npm start
```

Untuk mode development (auto-reload saat file diedit):
```bash
npm run dev
```

Port default adalah `3000` (atau gunakan environment variable `PORT=8000 npm start`).

---

## ⚙️ Konfigurasi Environment (`.env`)

Buat atau edit file `.env` di root folder `manga-api`:

```env
PORT=3000

# Nama author / pembuat API yang otomatis disisipkan di semua response
API_AUTHOR=dhiksn

# Kebijakan CORS (default: * atau isi domain tertentu seperti https://webkamu.com)
CORS_ORIGIN=*

# Izinkan proxy mem-fetch localhost/IP privat saat testing development (default: false)
ALLOW_LOCAL_PROXY=false

# Kredensial akun Softkomik untuk mengakses konten kategori NSFW
SOFTKOMIK_EMAIL=akun_anda@example.com
SOFTKOMIK_PASSWORD=password_rahasia_anda
```

---

## 📌 Daftar Endpoint REST API

Setiap endpoint mewajibkan parameter `:source` (misal: `softkomik`).

### 1. Sumber Manga (Sources)
- **Daftar Semua Sumber yang Tersedia**:
  ```http
  GET /api/sources
  ```
  **Response**:
  ```json
  {
    "success": true,
    "author": "dhiksn",
    "data": [
      { "id": "softkomik", "name": "Softkomik" },
      { "id": "komiku", "name": "Komiku" }
    ]
  }
  ```

---

### 2. Manga List (Populer & Terbaru)
- **Manga Populer / Trending**:
  ```http
  GET /api/sources/:source/popular?page=1
  ```
  *Contoh*: `http://localhost:3000/api/sources/softkomik/popular?page=1`

  **Response**:
  ```json
  {
    "success": true,
    "author": "dhiksn",
    "source": "softkomik",
    "data": [
      {
        "title": "Nano Machine",
        "slug": "nano-machine-bahasa-indonesia",
        "cover": "https://cover.softdevices.my.id/softkomik-cover/uploads-cover/nano-machine/nano-machine.webp",
        "status": "ongoing",
        "type": "manhwa",
        "latestChapter": "338"
      }
    ],
    "pagination": {
      "page": 1,
      "maxPage": 419,
      "prevPage": null,
      "nextPage": 2
    }
  }
  ```

- **Manga Rilis Terbaru / Pustaka (Latest)**:
  - **Softkomik**: Scrape langsung dari `https://softkomik.app/komik/update`. Secara default (`category=all`), semua kategori (normal, sensitive, nsfw) otomatis **digabungkan dan diurutkan berdasarkan update paling baru di paling atas** (`updatedAt` descending).
    ```http
    # Gabungan semua kategori (default, terupdate paling atas):
    GET /api/sources/softkomik/latest?page=1

    # Atau filter per kategori spesifik:
    GET /api/sources/softkomik/latest?page=1&category=normal
    GET /api/sources/softkomik/latest?page=1&category=sensitive
    GET /api/sources/softkomik/latest?page=1&category=nsfw
    ```

  - **Komiku**: Scrape komik terbaru langsung dari Pustaka `https://komiku.org/pustaka/`.
    ```http
    GET /api/sources/komiku/latest?page=1
    ```

  *Contoh Response Softkomik*:
  ```json
  {
    "success": true,
    "author": "dhiksn",
    "source": "softkomik",
    "category": "all",
    "data": [
      {
        "title": "The Extra’s Academy Survival Guide",
        "slug": "the-extras-academy-survival-guide-bahasa-indonesia",
        "cover": "https://cover.softdevices.my.id/softkomik-cover/image-cover-2/the-extras-academy-survival-guide.jpg",
        "status": "ongoing",
        "type": "manhwa",
        "latestChapter": "123",
        "updatedAt": "15 menit yang lalu",
        "contentRating": "normal"
      }
    ],
    "pagination": {
      "page": 1,
      "maxPage": 362,
      "prevPage": null,
      "nextPage": 2
    }
  }
  ```

  *Contoh Response Komiku*:
  ```json
  {
    "success": true,
    "author": "dhiksn",
    "source": "komiku",
    "from": "https://komiku.org/pustaka/",
    "data": [
      {
        "title": "The Terminally Ill Lady Fakes a Job with the Villain Family",
        "slug": "the-terminally-ill-lady-fakes-a-job-with-the-villain-family",
        "cover": "https://img.komiku.org/wp-content/uploads/...",
        "type": "manhwa",
        "latestChapter": "18",
        "updatedAt": "1 jam lalu"
      }
    ],
    "pagination": {
      "page": 1,
      "prevPage": null,
      "nextPage": 2
    }
  }
  ```

  > [!NOTE]
  > Untuk menyertakan konten kategori `nsfw` dalam gabungan atau filter spesifik, isi kredensial `SOFTKOMIK_EMAIL` dan `SOFTKOMIK_PASSWORD` di file `.env`. API akan otomatis login dan melampirkan cookie sesi. Jika tidak diset, kategori `normal` dan `sensitive` tetap berjalan normal tanpa error.

---

### 3. Daftar Direktori Semua Komik (List A-Z)
Mengambil daftar katalog komik lengkap (A-Z) dari `https://komiku.org/daftar-komik/`.
```http
# Halaman daftar komik:
GET /api/sources/komiku/list?page=1

# Filter berdasarkan huruf awalan judul (letter):
GET /api/sources/komiku/list?page=1&letter=A
GET /api/sources/komiku/list?page=1&letter=S
```

**Response**:
```json
{
  "success": true,
  "author": "dhiksn",
  "source": "komiku",
  "from": "https://komiku.org/daftar-komik/",
  "letter": "A",
  "data": [
    {
      "title": "A Revenge Guide for the Terminally",
      "slug": "a-revenge-guide-for-the-terminally",
      "cover": "https://thumbnail.komiku.to/img/upload/a_revenge_guide_for_the_terminally/img_68958eb08bd664.81717823.jpg",
      "status": "ongoing",
      "type": "manhwa",
      "genre": "Drama"
    }
  ],
  "pagination": {
    "page": 1,
    "maxPage": 159,
    "prevPage": null,
    "nextPage": 2
  }
}
```

---

### 4. Pencarian (Search)
- **Cari Manga berdasarkan Judul**:
  ```http
  GET /api/sources/:source/search?q=magic&page=1
  ```
  *Contoh*: `http://localhost:3000/api/sources/softkomik/search?q=solo&page=1`

  **Response**:
  ```json
  {
    "success": true,
    "author": "dhiksn",
    "source": "softkomik",
    "query": "magic",
    "data": [
      {
        "title": "Yes Ma'am (Uncensored)",
        "slug": "yes-ma-am-uncensored-bahasa-indonesia",
        "cover": "https://cover.softdevices.my.id/softkomik-cover/members/cover-359585-1788243728388-jkc35m3s.webp",
        "status": "ongoing",
        "type": "manhwa",
        "latestChapter": "011",
        "updatedAt": "3 minggu lalu",
        "contentRating": "adult_plus",
        "isAdult": true
      }
    ],
    "pagination": {
      "page": 1,
      "maxPage": 1,
      "prevPage": null,
      "nextPage": null
    }
  }
  ```

---

### 5. Genre Manga (List & Filter)
- **Daftar Semua Genre**:
  ```http
  GET /api/sources/:source/genres
  ```
  *Contoh*: `http://localhost:3000/api/sources/softkomik/genres`

- **Daftar Komik Berdasarkan Genre** (dari `https://softkomik.app/komik/genre/:genre`):
  ```http
  GET /api/sources/:source/genres/:genre?page=1
  ```
  *Contoh*: `http://localhost:3000/api/sources/softkomik/genres/Action?page=1`
  *Contoh Lain*: `http://localhost:3000/api/sources/softkomik/genres/Romance?page=1`

---

### 6. Tipe Manga (Manga, Manhwa, Manhua)
- **Daftar Tipe yang Didukung**:
  ```http
  GET /api/sources/:source/types
  ```
  *Contoh*: `http://localhost:3000/api/sources/softkomik/types`

- **Daftar Komik Berdasarkan Tipe** (dari `https://softkomik.app/komik/type/:type`):
  ```http
  GET /api/sources/:source/types/:type?page=1
  ```
  *Contoh*: `http://localhost:3000/api/sources/softkomik/types/manga?page=1`
  *Contoh Lain*: `http://localhost:3000/api/sources/softkomik/types/manhwa?page=1`
  *Contoh Lain*: `http://localhost:3000/api/sources/softkomik/types/manhua?page=1`

---

### 7. Detail Manga & Daftar Chapter
- **Ambil Sinopsis, Genre, Author, Chapter, dan Komik Serupa**:
  ```http
  GET /api/sources/:source/manga/:slug
  ```
  *Contoh*: `http://localhost:3000/api/sources/komiku/manga/komik-one-piece-indo`
  *Contoh*: `http://localhost:3000/api/sources/softkomik/manga/nano-machine-bahasa-indonesia`

  **Response**:
  ```json
  {
    "success": true,
    "author": "dhiksn",
    "source": "komiku",
    "data": {
      "title": "One Piece",
      "altTitle": "One Piece: Harta Karun Legendaris",
      "cover": "https://thumbnail.komiku.to/uploads/manga/komik-one-piece-indo/manga_thumbnail-Komik-One-Piece.jpg",
      "synopsis": "One Piece mengikuti petualangan Monkey D. Luffy...",
      "author": "Eiichiro Oda",
      "status": "ongoing",
      "type": "manga",
      "genres": ["Action", "Adventure", "Comedy", "Fantasy", "Shounen", "Supernatural"],
      "totalChapters": 1215,
      "chapters": [
        {
          "chapter": "1196",
          "title": "Chapter 1196",
          "endpoint": "/api/sources/komiku/chapter/komik-one-piece-indo/1196",
          "date": "15/10/2026"
        }
      ],
      "similar": [
        {
          "title": "Pick Me Up",
          "slug": "pick-me-up",
          "cover": "https://thumbnail.komiku.to/uploads/manga/pick-me-up/manga_img_horizontal-Pick-Me-Up-2.png",
          "type": "manhwa",
          "genre": "Aksi",
          "views": "5jt views",
          "description": "Seorang pemuda mencari jati diri di tengah tekanan sosial."
        }
      ]
    }
  }
  ```

---

### 8. Baca Chapter (Image Pages)
- **Ambil URL Semua Halaman Gambar dalam Chapter**:
  Mendukung pergantian server CDN melalui query parameter `?cdn=cdn1|cdn2|cdn3`:
  ```http
  GET /api/sources/:source/chapter/:slug/:chapter?cdn=cdn1
  GET /api/sources/:source/chapter/:slug/:chapter?cdn=cdn2
  GET /api/sources/:source/chapter/:slug/:chapter?cdn=cdn3
  ```
  *Contoh*: `http://localhost:3000/api/sources/softkomik/chapter/magic-emperor-bahasa-indonesia/924?cdn=cdn2`

  **Response**:
  ```json
  {
    "success": true,
    "author": "dhiksn",
    "source": "softkomik",
    "data": {
      "title": "Magic Emperor Chapter 924",
      "slug": "magic-emperor-bahasa-indonesia",
      "chapter": "924",
      "currentCdn": "cdn2",
      "availableCdns": [
        { "id": "cdn1", "name": "CDN 1 (image.komik.im)" },
        { "id": "cdn2", "name": "CDN 2 (psy1.komik.im)" },
        { "id": "cdn3", "name": "CDN 3 (image.komik.im Backup)" }
      ],
      "totalPages": 49,
      "headers": {
        "Referer": "https://softkomik.app/"
      },
      "pages": [
        {
          "page": 1,
          "url": "http://localhost:3000/api/proxy/image?url=https%3A%2F%2Fpsy1.komik.im%2F...",
          "directUrl": "https://psy1.komik.im/...",
          "proxyUrl": "http://localhost:3000/api/proxy/image?url=https%3A%2F%2Fpsy1.komik.im%2F..."
        }
      ]
    }
  }
  ```

  > [!TIP]
  > CDN gambar Softkomik (`image.komik.im`) memiliki proteksi anti-hotlink yang akan me-redirect gambar ke placeholder *"baca di web softkomik.org"* jika dibuka langsung di tab browser tanpa header `Referer`.
  > - Gunakan field `url` / `proxyUrl` untuk langsung menampilkan gambar di web/browser tanpa blokir.
  > - Jika aplikasi native Anda ingin mengakses `directUrl` langsung, sertakan header `"Referer": "https://softkomik.app/"`.

---

### 7. Image Proxy (Bypass Hotlink / CORS)
Bila aplikasi frontend Anda (web browser/mobile app) diblokir saat menampilkan gambar karena hotlink protection atau CORS, gunakan endpoint proxy ini:
```http
GET /api/proxy/image?url=<ENCODED_IMAGE_URL>
```

---

## ⚠️ Format Error Response & Status Code

Seluruh response error di API ini mengikuti format konsisten dengan field `author` tepat di bawah `success`:

```json
{
  "success": false,
  "author": "dhiksn",
  "error": {
    "code": "NOT_FOUND",
    "message": "Data tidak ditemukan"
  }
}
```

### Standar HTTP Status Code:
| Status Code | Kondisi | Keterangan |
| :---: | :--- | :--- |
| **`200 OK`** | Success | Permintaan berhasil diproses |
| **`400 Bad Request`** | Invalid parameter | Parameter query/body tidak valid, URL invalid, atau host lokal/private diblokir (SSRF) |
| **`404 Not Found`** | Data tidak ditemukan | Manga, chapter, atau endpoint tidak ditemukan |
| **`429 Too Many Requests`** | Terlalu banyak request | Melebihi batas rate limit (120 req/menit per IP) |
| **`500 Internal Server Error`** | Server error | Terjadi kegagalan internal pada server API |
| **`502 Bad Gateway`** | Target website gagal diakses | Website sumber (Softkomik) atau upstream CDN timeout / down / unreachable |

---

## 🛡️ Fitur Keamanan (Security)

1. **CORS (Cross-Origin Resource Sharing)**:
   - Dikonfigurasi menggunakan middleware `cors`.
   - Mengizinkan frontend (SPA / mobile app) mengakses API. Dapat dibatasi melalui `CORS_ORIGIN` di `.env`.
2. **URL Validation & Proteksi SSRF**:
   - Endpoint proxy memvalidasi protokol URL (`http:` dan `https:` saja).
   - Memblokir alamat lokal dan privat (`localhost`, `127.0.0.1`, subnet `10.x`, `192.168.x`, `172.16-31.x`, serta metadata cloud `169.254.169.254`).
   - *Catatan Development*: Untuk keperluan testing gambar dari server lokal Anda sendiri, set `ALLOW_LOCAL_PROXY=true` di `.env` untuk membypass proteksi ini selama pengembangan.
3. **Request Timeout**:
   - Timeout otomatis 25 detik untuk setiap incoming HTTP request di Express.
   - Timeout 15 detik untuk koneksi scraping ke website/CDN eksternal agar server tidak hanging.
4. **Rate Limiting**:
   - Sliding-window in-memory rate limiter membatasi 120 request per menit per alamat IP.
   - Otomatis merespons dengan HTTP `429 Too Many Requests` bila request melebihi kuota.
5. **Centralized Error Handler**:
   - Seluruh error operasional maupun runtime ditangkap oleh centralized error middleware dan dikonversi ke format standar JSON di atas.

---

## 🧩 Cara Menambah Sumber / Scraper Baru

Arsitektur dibuat modular dengan OOP (`BaseSource`). Untuk menambah scraper situs lain (misal: Komiku, Kiryuu, MangaDex, Westmanga):

1. Buat file baru di `src/sources/<nama_sumber>/<NamaSumber>Source.js`:
   ```javascript
   const BaseSource = require('../BaseSource');

   class KomikuSource extends BaseSource {
     constructor() {
       super('komiku', 'Komiku');
     }

     async getHome() { /* data banner & update beranda */ }
     async getPopular(page = 1) { /* list populer */ }
     async getLatest(page = 1) { /* list terbaru */ }
     async search(query, page = 1) { /* pencarian */ }
     async getDetails(slug) { /* sinopsis & chapter */ }
     async getPages(slug, chapter) { /* list gambar */ }
   }

   module.exports = KomikuSource;
   ```

2. Daftarkan di [`src/sources/index.js`](src/sources/index.js):
   ```javascript
   const KomikuSource = require('./komiku/KomikuSource');

   registerSource(new KomikuSource());
   ```

Semua endpoint `/api/sources/komiku/...` akan otomatis aktif secara instan!

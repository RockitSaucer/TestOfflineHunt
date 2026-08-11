/* REG SLAYER — production service worker
 * Caches app shell for return visits with no signal.
 * Map tiles: cache-first when already stored; network otherwise (then cache).
 */
const SHELL_CACHE = 'test-offline-hunt-shell-v1';
const TILE_CACHE = 'reg-slayer-tiles-v2';
const DATA_CACHE = 'reg-slayer-data-v1';
/** Soft cap on cached map tiles (~18KB avg → ~45MB). Oldest entries dropped first. */
const TILE_CACHE_MAX_ENTRIES = 2500;

const SHELL_ASSETS = [
  './plan-kit/plan-ui.css',
  './plan-kit/plan-events-lists.js',
  './',
  './index.html',
  './manifest.webmanifest',
  './hunt-slayer-logo.png',
  './reg-slayer-logo.png',
  './peak-rut-antlers.png',
  // App / homescreen icons
  './icons/app/hunt-180.png',
  './icons/app/hunt-192.png',
  './icons/app/hunt-512.png',
  './icons/app/hunt.ico',
  './icons/app/reg-180.png',
  './icons/app/reg-192.png',
  './icons/app/reg-512.png',
  './icons/app/reg.ico',
  // Peak-rut list skull (Available Hunts badge)
  './offline-engine.js',
  './auth-sync.js',
  './party-maps.js',
  './calendar-events.js',
  // WMA permit Zone A/B rings (required offline / hard-refresh)
  './wma-zones-data.js',
  './icons/tools/measure.png',
  './icons/tools/draw.png',
  './icons/tools/track.png',
  './icons/tools/layers.png',
  // Pin glyphs — needed offline when opening a map with saved pins
  './icons/pins/alligator.png',
  './icons/pins/arrow.png',
  './icons/pins/beaver_dam.png',
  './icons/pins/blood.png',
  './icons/pins/boat.png',
  './icons/pins/boat_ramp.png',
  './icons/pins/bow.png',
  './icons/pins/bow_stand.png',
  './icons/pins/bridge.png',
  './icons/pins/buck.png',
  './icons/pins/camera.png',
  './icons/pins/crossing.png',
  './icons/pins/deadhead.png',
  './icons/pins/doe.png',
  './icons/pins/feeder.png',
  './icons/pins/food.png',
  './icons/pins/house.png',
  './icons/pins/muzzleloader.png',
  './icons/pins/prints.png',
  './icons/pins/rifle.png',
  './icons/pins/rifle_stand.png',
  './icons/pins/rub.png',
  './icons/pins/salt.png',
  './icons/pins/scrape.png',
  './icons/pins/shed.png',
  './icons/pins/tent.png',
  './icons/pins/tree.png',
  './icons/pins/truck.png',
  './icons/pins/dobbs.png',
  // Directional location icons (party / GPS)
  './icons/dir/arrow_head.png',
  './icons/dir/boat.png',
  './icons/dir/bomb.png',
  './icons/dir/bullet.png',
  './icons/dir/capture.png',
  './icons/dir/car.png',
  './icons/dir/helicopter.png',
  './icons/dir/prop_plane.png',
  './icons/dir/rocket.png',
  './icons/dir/shuttle.png',
  './icons/dir/speed_boat.png',
  './icons/dir/truck.png',
  './icons/dir/dobbs.png',
  './icons/dir/x_wing.png',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/marker-icon.png',
  './vendor/leaflet/marker-icon-2x.png',
  './vendor/leaflet/marker-shadow.png',
  './vendor/leaflet/layers.png',
  './vendor/leaflet/layers-2x.png'
];

function isRadarTileUrl(url) {
  try {
    return new URL(url).hostname.includes('tilecache.rainviewer.com');
  } catch (e) {
    return false;
  }
}

function isTileUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname;
    // Radar frames: network-only (do not fill disk with ephemeral frames)
    if (h.includes('tilecache.rainviewer.com')) return false;
    if (h.includes('basemap.nationalmap.gov')) return true;
    if (h.includes('basemaps.cartocdn.com')) return true;
    if (h.includes('arcgisonline.com') && u.pathname.includes('/tile/')) return true;
    if (h.includes('wayback.maptiles.arcgis.com') && u.pathname.includes('/tile/')) return true;
    if (h.includes('tiles.regrid.com')) return true;
    if (h.includes('tile.openstreetmap.org')) return true;
    return false;
  } catch (e) {
    return false;
  }
}

/** Drop oldest tile entries when over budget (Cache API key order ≈ insert order). */
function trimTileCache(cache) {
  return cache.keys().then((keys) => {
    const over = keys.length - TILE_CACHE_MAX_ENTRIES;
    if (over <= 0) return;
    // Delete in batches to avoid blocking
    const drop = keys.slice(0, over);
    return Promise.all(drop.map((k) => cache.delete(k).catch(() => {})));
  }).catch(() => {});
}

function putTileAndTrim(cache, req, res) {
  return cache.put(req, res).then(() => {
    // Opportunistic trim (every put is fine; delete is cheap when under cap)
    if (Math.random() < 0.08) return trimTileCache(cache);
  }).catch(() => {});
}

function isApiUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname;
    if (h.includes('open-meteo.com')) return true;
    if (h.includes('api.weather.gov')) return true;
    if (h.includes('waterservices.usgs.gov') || h.includes('waterdata.usgs.gov')) return true;
    if (h.includes('conservationgis.alabama.gov')) return true;
    if (h.includes('services.arcgis.com') || h.includes('apps.fs.usda.gov')) return true;
    if (h.includes('api.rainviewer.com')) return true;
    return false;
  } catch (e) {
    return false;
  }
}

/** Live party / auth / map state — never long-cache (presence must stay current) */
function isSupabaseUrl(url) {
  try {
    const h = new URL(url).hostname;
    return h.includes('supabase.co') || h.includes('supabase.in');
  } catch (e) {
    return false;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      Promise.all(
        SHELL_ASSETS.map((path) =>
          cache.add(path).catch((err) => {
            console.warn('[SW] shell skip', path, err);
          })
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== TILE_CACHE && k !== DATA_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

function isShellHtmlRequest(req, url) {
  if (req.mode === 'navigate') return true;
  try {
    const u = new URL(url);
    const p = u.pathname || '';
    if (p === '/' || p.endsWith('/') || p.endsWith('.html')) return true;
  } catch (e) {}
  return false;
}

/** Core app files that must update on mobile as soon as a new deploy is online */
function isShellAppScript(url) {
  try {
    const u = new URL(url);
    const p = u.pathname || '';
    return (
      p.endsWith('/index.html') ||
      p.endsWith('/offline-engine.js') ||
      p.endsWith('/auth-sync.js') ||
      p.endsWith('/party-maps.js') ||
      p.endsWith('/calendar-events.js') ||
      p.endsWith('/wma-zones-data.js') ||
      p.endsWith('/sw.js') ||
      p.endsWith('/manifest.webmanifest')
    );
  } catch (e) {
    return false;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = req.url;

  // App shell / same-origin
  if (url.startsWith(self.registration.scope)) {
    /*
     * HTML + core JS: NETWORK-FIRST when online.
     * Cache-first left phones stuck on old deploys (desktop CDN looked new;
     * mobile SW kept serving reg-slayer-shell-vN index forever).
     * Offline still falls back to shell cache.
     */
    if (isShellHtmlRequest(req, url) || isShellAppScript(url)) {
      event.respondWith(
        fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() =>
            caches.match(req).then((cached) => {
              if (cached) return cached;
              if (isShellHtmlRequest(req, url)) return caches.match('./index.html');
              return Response.error();
            })
          )
      );
      return;
    }

    // Other same-origin assets (icons, vendor): cache-first, revalidate in background
    event.respondWith(
      caches.match(req).then((cached) => {
        const net = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => cached || Response.error());
        return cached || net;
      })
    );
    return;
  }

  // Supabase (presence, maps, auth): always network — never cache live GPS / map_state
  if (isSupabaseUrl(url)) {
    event.respondWith(
      fetch(req).catch(() => Response.error())
    );
    return;
  }

  // Radar tiles: network-only (short-lived frames — do not bloat TILE_CACHE)
  if (isRadarTileUrl(url)) {
    event.respondWith(
      fetch(req).catch(() => Response.error())
    );
    return;
  }

  // Map tiles: cache-first (offline packs + already-browsed tiles). No background revalidate
  // on every hit — saves cellular when panning over known tiles. New areas still network-fetch.
  if (isTileUrl(url)) {
    event.respondWith(
      caches.open(TILE_CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          if (cached) return cached;
          return fetch(req)
            .then((res) => {
              if (res && res.ok) {
                try {
                  putTileAndTrim(cache, req, res.clone());
                } catch (e) {}
              }
              return res;
            })
            .catch(() => Response.error());
        })
      )
    );
    return;
  }

  // Weather / GIS APIs: network-first, short offline fallback (not for presence)
  if (isApiUrl(url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            // RainViewer frame lists change constantly — do not fill DATA_CACHE
            if (!url.includes('api.rainviewer.com')) {
              caches.open(DATA_CACHE).then((c) => c.put(req, copy)).catch(() => {});
            }
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || Response.error())
        )
    );
  }
});

// Allow page to ask SW to precache a list of tile URLs
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'PRECACHE_URLS' && Array.isArray(data.urls)) {
    event.waitUntil(
      caches.open(TILE_CACHE).then(async (cache) => {
        let ok = 0;
        let fail = 0;
        for (const u of data.urls) {
          try {
            // Never precache radar frames
            if (isRadarTileUrl(u)) {
              fail++;
              continue;
            }
            const res = await fetch(u, { mode: 'cors', credentials: 'omit' });
            if (res && res.ok) {
              await cache.put(u, res.clone());
              ok++;
            } else {
              fail++;
            }
          } catch (e) {
            fail++;
          }
          if (event.source && (ok + fail) % 20 === 0) {
            event.source.postMessage({
              type: 'PRECACHE_PROGRESS',
              ok,
              fail,
              total: data.urls.length,
              packId: data.packId || null
            });
          }
        }
        try { await trimTileCache(cache); } catch (eT) {}
        if (event.source) {
          event.source.postMessage({
            type: 'PRECACHE_DONE',
            ok,
            fail,
            total: data.urls.length,
            packId: data.packId || null
          });
        }
      })
    );
  }
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

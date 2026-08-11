/**
 * REG SLAYER — offline engine
 * Offline map packs (2 mi radius), weather/water stale cache, connection UI.
 * Does not change online behavior when network is healthy.
 */
(function (global) {
  'use strict';

  var OFFLINE_PACKS_KEY = 'reg_slayer_offline_packs_v1';
  var OFFLINE_TIER_KEY = 'reg_slayer_offline_tier_v1';
  var WEATHER_DISK_KEY = 'reg_slayer_weather_disk_v1';
  var WATER_DISK_KEY = 'reg_slayer_water_disk_v1';
  var RADIUS_MI = 2; // legacy default (Standard tier supersedes for new downloads)
  var ZOOM_MIN = 10;
  var ZOOM_MAX = 15;
  var WEATHER_DISK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // keep last weather up to 7 days
  var WATER_DISK_TTL_MS = 24 * 60 * 60 * 1000;

  /**
   * Offline pack options.
   * Pin/map "Offline map" uses mi2 / mi5 / mi10.
   * Settings → Cloud & offline hosts statewide overview only.
   */
  var OFFLINE_TIERS = {
    mi2: {
      id: 'mi2',
      name: '2 miles',
      tagline: 'Current default · tight around a spot',
      mode: 'circle',
      radiusMi: 2,
      zMin: 10,
      zMax: 15,
      allowSat: true,
      sizeHint: '~1–10 MB',
      blurb: '2 miles around a pin or GPS (original offline pack size).'
    },
    mi5: {
      id: 'mi5',
      name: '5 miles',
      tagline: 'Hunt property / stands',
      mode: 'circle',
      radiusMi: 5,
      zMin: 10,
      zMax: 15,
      allowSat: true,
      sizeHint: '~15–40 MB topo · ~40–80 MB sat',
      blurb: '5 miles around a spot, zooms 10–15.'
    },
    mi10: {
      id: 'mi10',
      name: '10 miles',
      tagline: 'Lease / multi-stand',
      mode: 'circle',
      radiusMi: 10,
      zMin: 10,
      zMax: 15,
      allowSat: true,
      sizeHint: '~25–60 MB topo · ~50–120 MB sat',
      blurb: '10 miles around a spot, zooms 10–15.'
    },
    overview: {
      id: 'overview',
      name: 'Statewide overview',
      tagline: 'Alabama at a glance',
      mode: 'alabama_bbox',
      radiusMi: null,
      zMin: 10,
      zMax: 12,
      allowSat: false,
      sizeHint: '~80–200 MB (topo only)',
      blurb: 'Coarse statewide Alabama for navigation. Not stand-level — use 2/5/10 mi packs on hunt spots.'
    },
    // Back-compat aliases
    standard: null,
    extended: null
  };
  OFFLINE_TIERS.standard = OFFLINE_TIERS.mi5;
  OFFLINE_TIERS.extended = OFFLINE_TIERS.mi10;
  // Alabama rough bounds for overview packs
  var AL_BOUNDS = { south: 30.15, north: 35.02, west: -88.52, east: -84.85 };

  var TILE_TEMPLATES = {
    topo: {
      label: 'USGS Topography',
      // {z}/{y}/{x} Esri/USGS order
      urls: [
        'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}'
      ]
    },
    street: {
      label: 'Roads & Waterways',
      urls: [
        'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'
      ]
    },
    satellite: {
      label: 'Satellite',
      urls: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
      ]
    },
    lidar: {
      label: 'LiDAR Terrain',
      urls: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}'
      ]
    }
  };

  function now() {
    return Date.now();
  }

  function loadJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function saveJson(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (e) {
      console.warn('offline storage write failed', key, e);
      return false;
    }
  }

  function lonLatToTile(lng, lat, z) {
    var n = Math.pow(2, z);
    var x = Math.floor(((lng + 180) / 360) * n);
    var latRad = (lat * Math.PI) / 180;
    var y = Math.floor(
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
    );
    x = Math.max(0, Math.min(n - 1, x));
    y = Math.max(0, Math.min(n - 1, y));
    return { x: x, y: y };
  }

  /** Miles → degrees at latitude */
  function milesToDegLat(mi) {
    return mi / 69.0;
  }
  function milesToDegLng(mi, lat) {
    var cos = Math.cos((lat * Math.PI) / 180);
    if (Math.abs(cos) < 0.01) cos = 0.01;
    return mi / (69.0 * cos);
  }

  /**
   * Build tile URL list for a circle of radiusMi around lat/lng.
   * For each zoom, use the bounding box of the circle (simple, reliable).
   */
  function listTileUrls(lat, lng, radiusMi, basemapKey, zMin, zMax, listOpts) {
    basemapKey = basemapKey || 'topo';
    zMin = zMin != null ? zMin : ZOOM_MIN;
    zMax = zMax != null ? zMax : ZOOM_MAX;
    listOpts = listOpts || {};
    var tmpl = TILE_TEMPLATES[basemapKey] || TILE_TEMPLATES.topo;
    // Street template lists 2 CDN hosts — only use first pattern to avoid double-download
    var patterns = tmpl.urls && tmpl.urls.length
      ? (basemapKey === 'street' ? [tmpl.urls[0]] : tmpl.urls.slice(0, 1))
      : [];
    var dLat = milesToDegLat(radiusMi);
    var dLng = milesToDegLng(radiusMi, lat);
    var south = lat - dLat;
    var north = lat + dLat;
    var west = lng - dLng;
    var east = lng + dLng;
    return listTileUrlsForBbox(south, north, west, east, basemapKey, zMin, zMax, listOpts, patterns);
  }

  function listTileUrlsForBbox(south, north, west, east, basemapKey, zMin, zMax, listOpts, patternsOpt) {
    basemapKey = basemapKey || 'topo';
    zMin = zMin != null ? zMin : ZOOM_MIN;
    zMax = zMax != null ? zMax : ZOOM_MAX;
    listOpts = listOpts || {};
    var tmpl = TILE_TEMPLATES[basemapKey] || TILE_TEMPLATES.topo;
    var patterns = patternsOpt;
    if (!patterns || !patterns.length) {
      patterns = tmpl.urls && tmpl.urls.length
        ? (basemapKey === 'street' ? [tmpl.urls[0]] : tmpl.urls.slice(0, 1))
        : [];
    }
    var urls = [];
    var seen = {};
    var maxSide = listOpts.noCap ? 500 : (listOpts.maxSide != null ? listOpts.maxSide : 48);

    for (var z = zMin; z <= zMax; z++) {
      var nw = lonLatToTile(west, north, z);
      var se = lonLatToTile(east, south, z);
      var x0 = Math.min(nw.x, se.x);
      var x1 = Math.max(nw.x, se.x);
      var y0 = Math.min(nw.y, se.y);
      var y1 = Math.max(nw.y, se.y);
      if (x1 - x0 > maxSide) {
        var mx = Math.floor((x0 + x1) / 2);
        x0 = mx - Math.floor(maxSide / 2);
        x1 = x0 + maxSide;
      }
      if (y1 - y0 > maxSide) {
        var my = Math.floor((y0 + y1) / 2);
        y0 = my - Math.floor(maxSide / 2);
        y1 = y0 + maxSide;
      }
      for (var x = x0; x <= x1; x++) {
        for (var y = y0; y <= y1; y++) {
          patterns.forEach(function (pattern) {
            var u = pattern
              .replace('{z}', String(z))
              .replace('{x}', String(x))
              .replace('{y}', String(y));
            if (!seen[u]) {
              seen[u] = 1;
              urls.push(u);
            }
          });
        }
      }
    }
    return urls;
  }

  function listAlabamaOverviewUrls(basemapKey, zMin, zMax) {
    basemapKey = basemapKey === 'satellite' ? 'topo' : (basemapKey || 'topo');
    zMin = zMin != null ? zMin : 10;
    zMax = zMax != null ? zMax : 12;
    return listTileUrlsForBbox(
      AL_BOUNDS.south,
      AL_BOUNDS.north,
      AL_BOUNDS.west,
      AL_BOUNDS.east,
      basemapKey,
      zMin,
      zMax,
      { noCap: true }
    );
  }

  function getTier(tierId) {
    var t = OFFLINE_TIERS[tierId];
    if (t) return t;
    return OFFLINE_TIERS.mi2;
  }

  function getSelectedTierId() {
    try {
      var t = localStorage.getItem(OFFLINE_TIER_KEY);
      if (t === 'standard') t = 'mi5';
      if (t === 'extended') t = 'mi10';
      if (t && OFFLINE_TIERS[t] && t !== 'standard' && t !== 'extended') return t;
    } catch (e) {}
    return 'mi2';
  }

  function setSelectedTierId(tierId) {
    if (tierId === 'standard') tierId = 'mi5';
    if (tierId === 'extended') tierId = 'mi10';
    if (!OFFLINE_TIERS[tierId] || tierId === 'standard' || tierId === 'extended') tierId = 'mi2';
    try { localStorage.setItem(OFFLINE_TIER_KEY, tierId); } catch (e) {}
    return tierId;
  }

  function kbPerTile(basemapKey) {
    if (basemapKey === 'satellite') return 35;
    if (basemapKey === 'lidar') return 22;
    return 18;
  }

  function estimatePack(lat, lng, basemapKey, tierId) {
    var tier = getTier(tierId || getSelectedTierId());
    basemapKey = basemapKey || getActiveBasemapKey();
    if (tier.mode === 'alabama_bbox' || !tier.allowSat) {
      if (basemapKey === 'satellite') basemapKey = 'topo';
    }
    var urls;
    if (tier.mode === 'alabama_bbox') {
      urls = listAlabamaOverviewUrls(basemapKey, tier.zMin, tier.zMax);
    } else {
      var r = tier.radiusMi != null ? tier.radiusMi : RADIUS_MI;
      urls = listTileUrls(lat, lng, r, basemapKey, tier.zMin, tier.zMax);
    }
    var mb = (urls.length * kbPerTile(basemapKey)) / 1024;
    return {
      tileCount: urls.length,
      approxMb: Math.max(0.1, Math.round(mb * 10) / 10),
      tierId: tier.id,
      tierName: tier.name,
      radiusMi: tier.radiusMi,
      zMin: tier.zMin,
      zMax: tier.zMax,
      basemap: basemapKey,
      sizeHint: tier.sizeHint,
      mode: tier.mode
    };
  }

  function getPacks() {
    var arr = loadJson(OFFLINE_PACKS_KEY, []);
    return Array.isArray(arr) ? arr : [];
  }

  function setPacks(arr) {
    return saveJson(OFFLINE_PACKS_KEY, arr || []);
  }

  function getActiveBasemapKey() {
    try {
      if (typeof global.activeBasemapKey === 'string' && global.activeBasemapKey) {
        return global.activeBasemapKey;
      }
    } catch (e) {}
    return 'topo';
  }

  /**
   * Download tiles for a product tier around a point (or statewide overview).
   * Progress via onProgress({ok,fail,total,pct}).
   */
  function saveOfflineAround(lat, lng, opts) {
    opts = opts || {};
    var tier = getTier(opts.tierId || getSelectedTierId());
    var basemap = opts.basemap || getActiveBasemapKey();
    if (tier.mode === 'alabama_bbox' || !tier.allowSat) {
      if (basemap === 'satellite' || basemap === 'lidar') basemap = 'topo';
    }
    var label = opts.label || ('Offline ' + Number(lat).toFixed(4) + ', ' + Number(lng).toFixed(4));
    if (tier.mode === 'alabama_bbox') {
      label = opts.label || 'Alabama statewide overview';
      lat = lat != null && !isNaN(lat) ? lat : (AL_BOUNDS.south + AL_BOUNDS.north) / 2;
      lng = lng != null && !isNaN(lng) ? lng : (AL_BOUNDS.west + AL_BOUNDS.east) / 2;
    }
    var source = opts.source || 'pin'; // pin | custom-area | stand | settings
    var sourceId = opts.sourceId || null;
    var radiusMi = opts.radiusMi != null ? opts.radiusMi : (tier.radiusMi != null ? tier.radiusMi : RADIUS_MI);

    if (!navigator.onLine) {
      return Promise.reject(new Error('Need a network connection to download map tiles.'));
    }

    var urls =
      tier.mode === 'alabama_bbox'
        ? listAlabamaOverviewUrls(basemap, tier.zMin, tier.zMax)
        : listTileUrls(lat, lng, radiusMi, basemap, tier.zMin, tier.zMax);
    var packId =
      'pack_' +
      Date.now().toString(36) +
      '_' +
      Math.random().toString(36).slice(2, 7);

    var pack = {
      id: packId,
      lat: lat,
      lng: lng,
      radiusMi: radiusMi,
      basemap: basemap,
      tierId: tier.id,
      tierName: tier.name,
      zMin: tier.zMin,
      zMax: tier.zMax,
      label: label,
      source: source,
      sourceId: sourceId,
      createdAt: new Date().toISOString(),
      tileCount: urls.length,
      ok: 0,
      fail: 0,
      status: 'downloading'
    };

    var packs = getPacks().filter(function (p) {
      // replace prior pack for same custom area / near same pin
      if (sourceId && p.sourceId && String(p.sourceId) === String(sourceId)) return false;
      return true;
    });
    packs.push(pack);
    setPacks(packs);
    updateOfflineBanner();

    function report(ok, fail) {
      pack.ok = ok;
      pack.fail = fail;
      if (typeof opts.onProgress === 'function') {
        opts.onProgress({
          ok: ok,
          fail: fail,
          total: urls.length,
          pct: urls.length ? Math.round(((ok + fail) / urls.length) * 100) : 100,
          packId: packId
        });
      }
      // persist progress occasionally
      var all = getPacks();
      for (var i = 0; i < all.length; i++) {
        if (all[i].id === packId) {
          all[i] = pack;
          break;
        }
      }
      setPacks(all);
    }

    // Download via page Cache API (same cache name SW uses for offline tile serve).
    // More reliable than SW message batching across browsers.
    return new Promise(function (resolve, reject) {
      if (!('caches' in global)) {
        reject(new Error('This browser cannot store offline map tiles.'));
        return;
      }
      // Must match TILE_CACHE in sw.js (reg-slayer-tiles-v2)
      caches.open('reg-slayer-tiles-v2').then(async function (cache) {
        var ok = 0;
        var fail = 0;
        // Small concurrency for flaky rural LTE without flooding the radio
        var i = 0;
        var workers = 4;
        async function worker() {
          while (i < urls.length) {
            var idx = i++;
            var u = urls[idx];
            try {
              var res = await fetch(u, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
              if (res && res.ok) {
                await cache.put(u, res.clone());
                ok++;
              } else {
                fail++;
              }
            } catch (e) {
              fail++;
            }
            if ((ok + fail) % 12 === 0 || ok + fail === urls.length) {
              report(ok, fail);
            }
          }
        }
        await Promise.all(
          Array.from({ length: workers }, function () {
            return worker();
          })
        );
        pack.ok = ok;
        pack.fail = fail;
        pack.status = fail && !ok ? 'failed' : 'ready';
        pack.finishedAt = new Date().toISOString();
        var all = getPacks();
        for (var j = 0; j < all.length; j++) {
          if (all[j].id === packId) all[j] = pack;
        }
        setPacks(all);
        updateOfflineBanner();
        resolve(pack);
      }).catch(reject);
    });
  }

  function deleteOfflinePack(packId) {
    var packs = getPacks().filter(function (p) {
      return p.id !== packId;
    });
    setPacks(packs);
    updateOfflineBanner();
    // Note: individual tiles left in Cache API (shared); full clear via clearAllOfflineTiles
  }

  function clearAllOfflineTiles() {
    setPacks([]);
    var p = Promise.resolve();
    if ('caches' in global) {
      p = caches.delete('reg-slayer-tiles-v2');
    }
    updateOfflineBanner();
    return p;
  }

  // ----- Weather / water disk cache -----
  function weatherDiskKey(lat, lon, dateStr) {
    return (
      Number(lat).toFixed(3) +
      ',' +
      Number(lon).toFixed(3) +
      ',' +
      String(dateStr || '')
    );
  }

  function saveWeatherDisk(lat, lon, dateStr, data) {
    var store = loadJson(WEATHER_DISK_KEY, {});
    var k = weatherDiskKey(lat, lon, dateStr);
    store[k] = { ts: now(), data: data };
    // prune old / cap entries
    var keys = Object.keys(store);
    keys.forEach(function (key) {
      if (now() - (store[key].ts || 0) > WEATHER_DISK_TTL_MS) delete store[key];
    });
    keys = Object.keys(store);
    if (keys.length > 40) {
      keys
        .sort(function (a, b) {
          return (store[a].ts || 0) - (store[b].ts || 0);
        })
        .slice(0, keys.length - 40)
        .forEach(function (key) {
          delete store[key];
        });
    }
    saveJson(WEATHER_DISK_KEY, store);
  }

  function loadWeatherDisk(lat, lon, dateStr) {
    var store = loadJson(WEATHER_DISK_KEY, {});
    var k = weatherDiskKey(lat, lon, dateStr);
    var ent = store[k];
    if (!ent || !ent.data) return null;
    if (now() - (ent.ts || 0) > WEATHER_DISK_TTL_MS) return null;
    var data = ent.data;
    try {
      data = JSON.parse(JSON.stringify(ent.data));
      data._fromDiskCache = true;
      data._diskCacheAgeMs = now() - (ent.ts || 0);
    } catch (e) {
      return ent.data;
    }
    return data;
  }

  function saveWaterDisk(payload) {
    saveJson(WATER_DISK_KEY, { ts: now(), data: payload });
  }

  function loadWaterDisk() {
    var ent = loadJson(WATER_DISK_KEY, null);
    if (!ent || !ent.data) return null;
    if (now() - (ent.ts || 0) > WATER_DISK_TTL_MS) return null;
    return ent;
  }

  // ----- Connection banner -----
  function ensureBannerEl() {
    var el = document.getElementById('offline-status-banner');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'offline-status-banner';
    el.setAttribute('role', 'status');
    el.style.cssText =
      'display:none;position:sticky;top:0;z-index:9000;padding:6px 12px;font-size:12px;font-weight:600;text-align:center;letter-spacing:0.02em;';
    var brand = document.querySelector('.brand-header');
    if (brand && brand.parentNode) {
      brand.parentNode.insertBefore(el, brand.nextSibling);
    } else if (document.body) {
      document.body.insertBefore(el, document.body.firstChild);
    }
    return el;
  }

  function updateOfflineBanner(extraNote) {
    var el = ensureBannerEl();
    if (!el) return;
    var online = navigator.onLine;
    var packs = getPacks().filter(function (p) {
      return p.status === 'ready' || p.status === 'downloading';
    });
    var nReady = packs.filter(function (p) {
      return p.status === 'ready';
    }).length;
    var downloading = packs.some(function (p) {
      return p.status === 'downloading';
    });

    if (online && !extraNote && !downloading) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }

    el.style.display = 'block';
    if (!online) {
      el.style.background = '#5c3b12';
      el.style.color = '#ffd59a';
      el.style.borderBottom = '1px solid #8a5a20';
      var msg =
        'Offline mode — planner, saved pins/stands/custom areas, and cached maps still work.';
      if (nReady) msg += ' · ' + nReady + ' offline map pack' + (nReady === 1 ? '' : 's');
      if (extraNote) msg += ' · ' + extraNote;
      el.textContent = msg;
    } else if (downloading) {
      el.style.background = '#1a3a4a';
      el.style.color = '#9fd4ff';
      el.style.borderBottom = '1px solid #2a5a6a';
      el.textContent = extraNote || 'Downloading offline map tiles…';
    } else if (extraNote) {
      el.style.background = '#1a3a4a';
      el.style.color = '#9fd4ff';
      el.style.borderBottom = '1px solid #2a5a6a';
      el.textContent = extraNote;
      setTimeout(function () {
        if (navigator.onLine) {
          el.style.display = 'none';
        }
      }, 4000);
    }
  }

  function fetchWithTimeout(url, options, ms) {
    options = options || {};
    ms = ms || 12000;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    var opts = Object.assign({}, options);
    if (ctrl) opts.signal = ctrl.signal;
    var p = fetch(url, opts);
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        reject(new Error('Request timed out'));
      }, ms);
    });
    return Promise.race([p, timeout]).finally(function () {
      if (timer) clearTimeout(timer);
    });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);

    // V7.0.24: do NOT auto-reload on controllerchange.
    // That hard reload was snapping the page back to top and wiping login fields
    // ~1s after open (desktop, browser, phone). New shell assets apply on the
    // next natural navigation / hard refresh; map data uses Settings → Display
    // "Load map from cloud" instead.

    return navigator.serviceWorker
      // Cache-bust query forces mobile browsers to re-check SW script on each deploy bump
      .register('./sw.js?v=shell97', { scope: './' })
      .then(function (reg) {
        console.info('[Offline] SW registered', reg.scope);
        // Force update check every launch (critical for iOS/Android home-screen / PWA)
        try {
          if (reg && typeof reg.update === 'function') {
            reg.update().catch(function () {});
          }
        } catch (eU) {}
        // Activate waiting worker in the background (no page reload)
        try {
          if (reg.waiting) {
            reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          }
        } catch (eW) {}
        try {
          reg.addEventListener('updatefound', function () {
            var nw = reg.installing;
            if (!nw) return;
            nw.addEventListener('statechange', function () {
              if (nw.state === 'installed' && navigator.serviceWorker.controller) {
                try { nw.postMessage({ type: 'SKIP_WAITING' }); } catch (eM) {}
              }
            });
          });
        } catch (eUf) {}
        // Periodic update checks while the tab is open (mobile often freezes SW checks)
        // Phase A: 15 min (was 5) and only when tab is visible
        try {
          setInterval(function () {
            try {
              if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
              if (reg.update) reg.update();
            } catch (eI) {}
          }, 15 * 60 * 1000);
        } catch (eInt) {}
        try {
          document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible' && reg.update) {
              reg.update().catch(function () {});
            }
          });
        } catch (eVis) {}
        return reg;
      })
      .catch(function (err) {
        console.warn('[Offline] SW register failed', err);
        return null;
      });
  }

  // Public API
  var api = {
    RADIUS_MI: RADIUS_MI,
    ZOOM_MIN: ZOOM_MIN,
    ZOOM_MAX: ZOOM_MAX,
    OFFLINE_TIERS: OFFLINE_TIERS,
    getTier: getTier,
    getSelectedTierId: getSelectedTierId,
    setSelectedTierId: setSelectedTierId,
    listTileUrls: listTileUrls,
    listAlabamaOverviewUrls: listAlabamaOverviewUrls,
    estimatePack: estimatePack,
    saveOfflineAround: saveOfflineAround,
    getPacks: getPacks,
    deleteOfflinePack: deleteOfflinePack,
    clearAllOfflineTiles: clearAllOfflineTiles,
    saveWeatherDisk: saveWeatherDisk,
    loadWeatherDisk: loadWeatherDisk,
    saveWaterDisk: saveWaterDisk,
    loadWaterDisk: loadWaterDisk,
    updateOfflineBanner: updateOfflineBanner,
    fetchWithTimeout: fetchWithTimeout,
    registerServiceWorker: registerServiceWorker,
    TILE_TEMPLATES: TILE_TEMPLATES
  };

  global.RegSlayerOffline = api;

  // Boot connection listeners when DOM ready
  function bootUi() {
    updateOfflineBanner();
    window.addEventListener('online', function () {
      updateOfflineBanner('Back online');
    });
    window.addEventListener('offline', function () {
      updateOfflineBanner();
    });
    registerServiceWorker();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootUi);
  } else {
    bootUi();
  }
})(typeof window !== 'undefined' ? window : self);

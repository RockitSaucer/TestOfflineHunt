/* REG SLAYER — multi private maps, party presence, share-to-map (extends RegSlayerCloud) */
(function () {
  'use strict';
  if (!window.RegSlayerCloud) {
    console.warn('RegSlayerCloud missing — party maps extension skipped');
    return;
  }

  var C = window.RegSlayerCloud;
  var PRESENCE_KEY = 'reg_slayer_sharing_loc_v1';
  var ARROW_KEY = 'reg_slayer_my_arrow_color_v1';
  var DIR_ICON_KEY = 'reg_slayer_my_dir_icon_v1';
  var DIR_SCALE_KEY = 'reg_slayer_my_dir_scale_v1';
  var HIDDEN_MEMBERS_KEY = 'reg_slayer_hidden_party_content_v1';
  var MAP_ALIAS_KEY = 'reg_slayer_map_alias_v1';
  var PARTY_PREFS_LOCAL_KEY = 'reg_slayer_party_prefs_local_v1';
  /**
   * Share-location preference survives idle auto-pause.
   * want=true keeps the toolbar toggle on. While backgrounded, GPS keeps
   * pinging ~every 20s (pos+heading). After 1h away without reopening the app,
   * active GPS pauses; toggle stays on and resumes when they return.
   */
  var SHARE_PREF_KEY = 'reg_slayer_share_loc_pref_v2';
  /** Directional icons for party/GPS (from icons/dir — location icons pipeline). */
  var DIR_ICON_CATALOG = [
    // Tip of broadhead = look direction. PNG tip is "up" at rest → frontDeg 0 (180 was reverse).
    { id: 'arrow_head', name: 'Arrow head', src: 'icons/dir/arrow_head.png', frontDeg: 0 },
    { id: 'boat', name: 'Boat', src: 'icons/dir/boat.png', frontDeg: 0 },
    // PNG is diagonal: nose lower-left (~225°). Rotate −225° so tip points up.
    { id: 'bomb', name: 'Bomb', src: 'icons/dir/bomb.png', frontDeg: 225 },
    { id: 'bullet', name: 'Bullet', src: 'icons/dir/bullet.png', frontDeg: 0 },
    { id: 'capture', name: 'Capture', src: 'icons/dir/capture.png', frontDeg: 0 },
    { id: 'car', name: 'Car', src: 'icons/dir/car.png', frontDeg: 0 },
    { id: 'helicopter', name: 'Helicopter', src: 'icons/dir/helicopter.png', frontDeg: 0 },
    { id: 'prop_plane', name: 'Prop plane', src: 'icons/dir/prop_plane.png', frontDeg: 180 },
    { id: 'rocket', name: 'Rocket', src: 'icons/dir/rocket.png', frontDeg: 0 },
    { id: 'shuttle', name: 'Shuttle', src: 'icons/dir/shuttle.png', frontDeg: 0 },
    { id: 'speed_boat', name: 'Speed Boat', src: 'icons/dir/speed_boat.png', frontDeg: 0 },
    { id: 'truck', name: 'Truck', src: 'icons/dir/truck.png', frontDeg: 0 },
    // Upright profile (head at top). frontDeg 0 = head leads with device heading
    // (same model as default arrow tip). Do not use 90 — that laid the figure on its side.
    { id: 'dobbs', name: 'Dobbs', src: 'icons/dir/dobbs.png', frontDeg: 0 },
    { id: 'x_wing', name: 'X-wing', src: 'icons/dir/x_wing.png', frontDeg: 0 },
    // Procedural SVG (no PNG): solid fill + opposite-wheel eyes/mouth. frontDeg 0 = upright when heading north.
    { id: 'smiley', name: 'Smiley', frontDeg: 0, render: 'svg-smiley' }
  ];
  var DIR_ICON_BUST = 'dir8';
  /**
   * Presence cadence tiers (GPS share only — does not change pins/weather/map_state).
   * Moving → burst; still → slower heartbeat; background → ~20s; large parties slightly slower.
   * Delta gate skips worthless radio when pos/heading barely changed (still heartbeats for TTL).
   */
  var MOVE_M = 12; // meters = "moving" for burst tier
  var DELTA_M = 15; // skip non-heartbeat upsert if moved less than this
  var DELTA_HEADING_DEG = 15; // and turned less than this
  var MOVE_MS = 4000; // min interval while walking/driving (foreground)
  var HEARTBEAT_MS = 9000; // standing still but recently moved
  var STATIONARY_MS = 50000; // long sit (~45–60s) when barely moving
  var HEADING_PUSH_DEG = 12; // re-push when facing turns (foreground heading-only)
  var HEADING_PUSH_MS = 2000; // min interval for heading-only updates (visible only)
  var BG_HEARTBEAT_MS = 20000; // background pos+heading combined
  /** Auto-pause live GPS if the user has not viewed the map for this long */
  var SHARE_IDLE_MS = 60 * 60 * 1000;
  /** Peer presence poll when shared map is open (realtime also fires — this is backup) */
  var PULL_MS = 2500;
  var PULL_MS_LARGE = 4000; // slightly calmer when many members; realtime still snappy
  var PRESENCE_STALE_MS = 3.5 * 60 * 1000; // hide peer after silence (covers 20s bg pings)
  var LIST_MEMBERS_MIN_MS = 25000; // don't re-fetch profiles every presence tick

  var presenceTimer = null;
  var presenceWatch = null;
  var presenceChannel = null;
  var headingOrientHandler = null;
  var headingWatchOn = false;
  /** Actively broadcasting GPS to the party */
  var sharing = false;
  /** User wants share-location on (toolbar stays toggled; may outlive active GPS) */
  var shareWanted = false;
  var shareStartedAt = 0;
  /** Last time the user viewed the map / app (resets idle timer) */
  var lastMapViewAt = Date.now();
  var shareMapViewWired = false;
  var lastSent = { lat: null, lng: null, heading: null, at: 0 };
  var lastRealMoveAt = 0; // for stationary tier
  var lastFacingHeading = null; // device compass / GPS course
  var lastHeadingPushAt = 0;
  var lastListMembersAt = 0;
  var partyPullInterval = null;
  var partyLayer = null;
  var partyMarkers = {};
  var myArrowColor = '#e11d1d';
  var myDirIconId = null; // custom directional icon for self (null = default triangle)
  var myDirIconScale = 1; // own marker size 0.4–1.6
  // memberId -> { nickname, arrow_color, show_content, direction_icon_id,
  //   icon_scale (0.4–1.6), marker_hidden (bool) — scale/hidden are local-only }
  var partyPrefs = {};
  var hiddenContentOwners = {}; // userId -> true means HIDE their content
  /** Selected map row in Settings → My Maps (for members list; View Map sets active view). */
  var mapsUiSelected = { kind: null, id: null };
  var _dirPickerOnPick = null;
  var _dirPickerSelected = null;
  var _dirPickerColor = '#e11d1d';
  var _dirGlyphFilterSeq = 0;

  try {
    var ac = localStorage.getItem(ARROW_KEY);
    if (ac) myArrowColor = ac;
  } catch (e) {}
  try {
    var di = localStorage.getItem(DIR_ICON_KEY);
    if (di) myDirIconId = di;
  } catch (eDi) {}
  try {
    var ds = parseFloat(localStorage.getItem(DIR_SCALE_KEY) || '1');
    if (!isNaN(ds) && ds > 0) myDirIconScale = Math.max(0.4, Math.min(1.6, ds));
  } catch (eDs) {}

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function getSb() {
    // Prefer live client from auth-sync (same session). Fallbacks for load order races.
    try {
      if (C && typeof C.getClient === 'function' && C.getClient()) return C.getClient();
    } catch (e0) {}
    try {
      if (C && C._sb) return C._sb;
    } catch (e1) {}
    return window.__rsSb || null;
  }
  function getUser() {
    if (window.__rsUser) return window.__rsUser;
    return null;
  }
  /** Leaflet map — index.html uses `let map` and also sets window.map after init. */
  function getMap() {
    if (window.map) return window.map;
    try {
      if (typeof map !== 'undefined' && map) return map;
    } catch (e) {}
    return null;
  }

  // Expose helpers the original module doesn't
  // Patch: we reach into original by re-wrapping public API after boot
  function ensurePartyLayer() {
    var m = getMap();
    if (!m || typeof L === 'undefined') return null;
    if (!partyLayer) {
      partyLayer = L.layerGroup().addTo(m);
    } else if (!m.hasLayer(partyLayer)) {
      try { partyLayer.addTo(m); } catch (eA) {}
    }
    try { partyLayer.bringToFront(); } catch (eF) {}
    return partyLayer;
  }

  function haversineM(aLat, aLng, bLat, bLng) {
    var R = 6371000;
    var toR = Math.PI / 180;
    var dLat = (bLat - aLat) * toR;
    var dLng = (bLng - aLng) * toR;
    var x = Math.sin(dLat / 2);
    var y = Math.sin(dLng / 2);
    var h = x * x + Math.cos(aLat * toR) * Math.cos(bLat * toR) * y * y;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function normalizeHeading(d) {
    d = Number(d);
    if (isNaN(d)) return null;
    d = d % 360;
    if (d < 0) d += 360;
    return d;
  }

  function headingDelta(a, b) {
    a = normalizeHeading(a);
    b = normalizeHeading(b);
    if (a == null || b == null) return 180;
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  /** Shared-map party size (for adaptive GPS/presence radio only). */
  function partyMemberCount() {
    try {
      var arr = window.__rsPartyMembers;
      if (arr && arr.length) return arr.length;
    } catch (e) {}
    return 1;
  }

  /** Scale intervals up slightly when many hunters share one map (smooth for everyone). */
  function partySizeScale() {
    var n = partyMemberCount();
    if (n >= 10) return 1.55;
    if (n >= 7) return 1.35;
    if (n >= 5) return 1.2;
    return 1;
  }

  /**
   * Min ms between presence upserts for current situation.
   * @param {boolean} moved meaningful position change
   * @param {boolean} bg app backgrounded
   */
  function presenceCadenceMs(moved, bg) {
    var sc = partySizeScale();
    if (bg) return Math.round(BG_HEARTBEAT_MS * sc);
    if (moved) return Math.round(MOVE_MS * sc);
    var sitMs = Date.now() - (lastRealMoveAt || lastSent.at || 0);
    if (sitMs >= 45000) return Math.round(STATIONARY_MS * sc);
    return Math.round(HEARTBEAT_MS * sc);
  }

  function peerPullIntervalMs() {
    var n = partyMemberCount();
    return n >= 7 ? PULL_MS_LARGE : PULL_MS;
  }

  /** Prefer device compass; fall back to GPS course-over-ground. */
  function resolveFacingHeading(gpsHeading) {
    var h = null;
    try {
      if (typeof window.deviceHeadingDeg === 'number' && !isNaN(window.deviceHeadingDeg)) {
        h = window.deviceHeadingDeg;
      }
    } catch (e0) {}
    if (h == null && lastFacingHeading != null) h = lastFacingHeading;
    if (h == null && gpsHeading != null && !isNaN(gpsHeading)) h = gpsHeading;
    h = normalizeHeading(h);
    if (h != null) lastFacingHeading = h;
    return h;
  }

  function getDirIconById(id) {
    if (!id) return null;
    for (var i = 0; i < DIR_ICON_CATALOG.length; i++) {
      if (DIR_ICON_CATALOG[i].id === id) return DIR_ICON_CATALOG[i];
    }
    return null;
  }
  function dirIconSrc(id) {
    var ic = getDirIconById(id);
    if (!ic || !ic.src) return '';
    return ic.src + (DIR_ICON_BUST ? ('?v=' + DIR_ICON_BUST) : '');
  }

  function hexToRgbDir(hex) {
    hex = normalizeDirHex(hex);
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16)
    };
  }

  function rgbToHslDir(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var h = 0;
    var s = 0;
    var l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return { h: h * 360, s: s, l: l };
  }

  function hslToHexDir(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(1, s));
    l = Math.max(0, Math.min(1, l));
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2;
    var r = 0;
    var g = 0;
    var b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    function ch(v) {
      var n = Math.round((v + m) * 255);
      n = Math.max(0, Math.min(255, n));
      var t = n.toString(16);
      return t.length === 1 ? '0' + t : t;
    }
    return '#' + ch(r) + ch(g) + ch(b);
  }

  /** True color-wheel complement: HSL hue + 180°, same S/L. */
  function oppositeWheelHex(hex) {
    var rgb = hexToRgbDir(hex);
    var hsl = rgbToHslDir(rgb.r, rgb.g, rgb.b);
    return hslToHexDir(hsl.h + 180, hsl.s, hsl.l);
  }

  function relativeLuminanceDir(hex) {
    var rgb = hexToRgbDir(hex);
    function lin(c) {
      c = c / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
  }

  /**
   * Eyes/mouth color for smiley: opposite on wheel; black/white/gray → hard contrast
   * so features stay visible (black fill → white features, etc.).
   */
  function featureContrastHex(fillHex) {
    fillHex = normalizeDirHex(fillHex);
    var rgb = hexToRgbDir(fillHex);
    var hsl = rgbToHslDir(rgb.r, rgb.g, rgb.b);
    var lum = relativeLuminanceDir(fillHex);
    if (hsl.s < 0.12 || lum < 0.12 || lum > 0.85) {
      return lum > 0.5 ? '#000000' : '#ffffff';
    }
    return oppositeWheelHex(fillHex);
  }

  /** Procedural dual-color smiley (fill = custom color, features = opposite/contrast). */
  function dirIconSmileyMarkup(hex, size) {
    var s = size || 30;
    hex = normalizeDirHex(hex);
    var feat = featureContrastHex(hex);
    return (
      '<svg class="rs-dir-icon-svg rs-dir-smiley" width="' + s + '" height="' + s + '" viewBox="0 0 100 100" ' +
        'xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" ' +
        'style="display:block;overflow:visible;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.45));">' +
        '<circle cx="50" cy="50" r="46" fill="' + hex + '" stroke="#000000" stroke-width="4"/>' +
        '<circle cx="35" cy="40" r="7" fill="' + feat + '"/>' +
        '<circle cx="65" cy="40" r="7" fill="' + feat + '"/>' +
        '<path d="M30 58 Q50 78 70 58" fill="none" stroke="' + feat +
          '" stroke-width="6" stroke-linecap="round"/>' +
      '</svg>'
    );
  }
  function prefKey(uid) {
    return String(uid == null ? '' : uid);
  }

  function getPartyPref(uid) {
    var k = prefKey(uid);
    return partyPrefs[k] || partyPrefs[uid] || {};
  }

  /**
   * Which direction icon to draw for a member on THIS device:
   * 1) If I set a custom icon for them (party prefs) → use that (only I see it)
   * 2) Else use their profile default (e.g. Scott’s rocket shows as rocket for everyone)
   * 3) Else default red triangle
   */
  function memberDirIconId(m) {
    if (!m) return null;
    var uid = m.user_id != null ? m.user_id : m.id;
    var pref = getPartyPref(uid);
    if (Object.prototype.hasOwnProperty.call(pref, 'direction_icon_id')) {
      var override = pref.direction_icon_id;
      // Non-empty override wins for me only. Empty/null = fall back to their profile default.
      if (override) return override;
    }
    return m.direction_icon_id || null;
  }

  function memberIconScale(m) {
    if (!m) return 1;
    var pref = getPartyPref(m.user_id != null ? m.user_id : m.id);
    var s = pref && pref.icon_scale != null ? Number(pref.icon_scale) : 1;
    if (isNaN(s) || s <= 0) s = 1;
    return Math.max(0.4, Math.min(1.6, s));
  }

  function memberMarkerHidden(m) {
    if (!m) return false;
    var pref = getPartyPref(m.user_id != null ? m.user_id : m.id);
    return !!(pref && pref.marker_hidden);
  }

  function memberIconSizePx(m) {
    // Base custom icon ~30px; scale 100% = 30
    return Math.round(30 * memberIconScale(m));
  }

  function memberIconSignature(m) {
    // "a2" = center-anchor layout (fixes ~100–150 yd offset from bottom-anchored name+icon stack)
    return 'a2|' + String(memberDirIconId(m) || '') + '|' + String(memberColor(m) || '') +
      '|' + String(memberIconScale(m)) + '|' + (memberMarkerHidden(m) ? '1' : '0');
  }

  function myDefaultDirIconLabel() {
    if (!myDirIconId) return 'Custom default arrow';
    var ic = getDirIconById(myDirIconId);
    return ic ? ('Arrow: ' + ic.name) : 'Custom default arrow';
  }
  function syncMyDirIconSettingsBtn() {
    var btn = $('set-my-dir-icon-btn');
    if (btn) btn.textContent = myDefaultDirIconLabel();
  }
  function openMyDefaultDirIcon() {
    openDirIconPicker({
      title: 'Your default direction icon',
      currentId: myDirIconId || null,
      currentColor: myArrowColor || '#e11d1d',
      currentScale: myDirIconScale || 1,
      mode: 'self',
      onPick: function (id, color, scale) {
        myDirIconId = id || null;
        if (color) myArrowColor = color;
        if (scale != null && !isNaN(scale)) {
          myDirIconScale = Math.max(0.4, Math.min(1.6, Number(scale)));
        }
        try {
          if (myDirIconId) localStorage.setItem(DIR_ICON_KEY, myDirIconId);
          else localStorage.removeItem(DIR_ICON_KEY);
          if (myArrowColor) localStorage.setItem(ARROW_KEY, myArrowColor);
          localStorage.setItem(DIR_SCALE_KEY, String(myDirIconScale));
        } catch (eL) {}
        try {
          document.documentElement.style.setProperty('--gps-arrow-color', myArrowColor);
        } catch (eCss) {}
        try {
          var sb = getSb() || window.__rsSb;
          var user = getUser() || window.__rsUser;
          if (sb && user) {
            sb.from('profiles').update({
              direction_icon_id: myDirIconId,
              arrow_color: myArrowColor
            }).eq('id', user.id).then(function () {});
          }
        } catch (eP) {}
        syncMyDirIconSettingsBtn();
        try {
          if (typeof setGpsMarker === 'function' && typeof userLat !== 'undefined' && userLat != null) {
            setGpsMarker(userLat, userLng);
          }
        } catch (eG) {}
        try {
          if (window.showAppCopyToast) {
            showAppCopyToast('<span class="act">Default arrow updated</span><br>' +
              (myDirIconId ? esc((getDirIconById(myDirIconId) || {}).name || myDirIconId) : 'Default triangle'));
          }
        } catch (eT) {}
      }
    });
  }
  window.openMyDefaultDirIcon = openMyDefaultDirIcon;
  window.syncMyDirIconSettingsBtn = syncMyDirIconSettingsBtn;

  function normalizeDirHex(hex) {
    if (typeof normalizeHexColor === 'function') {
      return normalizeHexColor(hex) || '#e11d1d';
    }
    var h = String(hex || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(h)) return h.toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(h)) {
      return ('#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3]).toLowerCase();
    }
    return '#e11d1d';
  }

  /**
   * Recolor black silhouette PNGs to a solid hex + thin black outline
   * (matches default GPS arrow stroke). SVG smileys use dual-color path.
   */
  function dirIconColoredMarkup(iconId, hex, size) {
    var s = size || 30;
    var icMeta = getDirIconById(iconId);
    if (icMeta && (icMeta.render === 'svg-smiley' || icMeta.id === 'smiley')) {
      return dirIconSmileyMarkup(hex, s);
    }
    var img = dirIconSrc(iconId);
    if (!img) return '';
    hex = normalizeDirHex(hex);
    _dirGlyphFilterSeq += 1;
    var fid = 'dgf' + _dirGlyphFilterSeq + '_' + String(iconId || 'x').replace(/[^a-z0-9_-]/gi, '');
    // Outline thickness scales with size; ~40% thinner so silhouettes stay sharp
    var outlineR = s >= 36 ? 0.81 : (s >= 28 ? 0.72 : 0.63);
    var src = String(img)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return (
      '<svg class="rs-dir-icon-svg" width="' + s + '" height="' + s + '" viewBox="0 0 ' + s + ' ' + s + '" ' +
        'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
        'aria-hidden="true" focusable="false" style="display:block;overflow:visible;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.45));">' +
        '<defs>' +
          '<filter id="' + fid + '" x="-35%" y="-35%" width="170%" height="170%" color-interpolation-filters="sRGB">' +
            // Expand silhouette → black stroke ring (like default arrow outline)
            '<feMorphology in="SourceAlpha" operator="dilate" radius="' + outlineR + '" result="dilated"/>' +
            '<feFlood flood-color="#000000" flood-opacity="1" result="black"/>' +
            '<feComposite in="black" in2="dilated" operator="in" result="outline"/>' +
            // Colored fill from original alpha
            '<feFlood flood-color="' + hex + '" flood-opacity="1" result="flood"/>' +
            '<feComposite in="flood" in2="SourceAlpha" operator="in" result="fill"/>' +
            '<feMerge>' +
              '<feMergeNode in="outline"/>' +
              '<feMergeNode in="fill"/>' +
            '</feMerge>' +
          '</filter>' +
        '</defs>' +
        '<image width="' + s + '" height="' + s + '" href="' + src + '" xlink:href="' + src + '" ' +
          'filter="url(#' + fid + ')" preserveAspectRatio="xMidYMid meet"/>' +
      '</svg>'
    );
  }

  /**
   * Directional marker body: default triangle or custom icon (slightly larger than default arrow).
   * frontDeg = where the PNG nose points (0=up). CSS rot = heading − frontDeg.
   * color tints the silhouette (triangle fill or PNG recolor).
   * Rotation always around geometric center so lat/lng = person position (same as GPS arrow).
   */
  function buildDirBodyHtml(color, heading, iconId, sizePx) {
    var rot = heading != null && !isNaN(heading) ? (((Number(heading) % 360) + 360) % 360) : 0;
    var c = normalizeDirHex(color || '#2563eb');
    var ic = getDirIconById(iconId);
    if (ic) {
      var front = (ic.frontDeg != null && !isNaN(ic.frontDeg)) ? Number(ic.frontDeg) : 0;
      var cssRot = ((rot - front) % 360 + 360) % 360;
      // Custom icons: slightly larger than default ~17–24px arrow
      var s = sizePx || 30;
      var glyph = dirIconColoredMarkup(ic.id, c, s);
      return (
        '<div class="party-arrow-rot rs-dir-icon-rot" data-front="' + front + '" style="width:' + s +
          'px;height:' + s + 'px;transform:rotate(' + cssRot.toFixed(1) +
          'deg);transform-origin:center center;will-change:transform;line-height:0;">' +
          glyph +
        '</div>'
      );
    }
    var w = sizePx ? Math.round(sizePx * 0.8) : 24;
    var h = sizePx ? Math.round(sizePx * 1.13) : 34;
    return (
      '<div class="party-arrow-rot" data-front="0" style="width:' + w + 'px;height:' + h +
        'px;transform:rotate(' + rot.toFixed(1) + 'deg);transform-origin:center center;will-change:transform;">' +
        '<svg viewBox="0 0 24 32" width="' + w + '" height="' + h + '" style="display:block;">' +
          '<path d="M12 1.5 L22.5 29.5 L12 23.2 L1.5 29.5 Z" fill="' + c +
            '" stroke="#000" stroke-width="0.9" stroke-linejoin="round"/>' +
        '</svg>' +
      '</div>'
    );
  }

  /**
   * Party member marker. sizePx scales the directional icon; hidden draws a small
   * colored ring-dot (same idea as a hidden map pin) that still tracks location.
   *
   * CRITICAL — location accuracy:
   * Leaflet lat/lng must sit on the CENTER of the glyph (person's position).
   * Name labels float ABOVE with absolute positioning so they never shift the anchor.
   * Old layout stacked name+icon with iconAnchor at box bottom → ~100–150 yd visual error.
   */
  function buildPartyArrowIcon(color, label, heading, iconId, sizePx, hidden) {
    var name = esc((label || '').slice(0, 16));
    var c = normalizeDirHex(color || '#2563eb');
    var html;
    var labelCss =
      'position:absolute;left:50%;bottom:100%;transform:translateX(-50%);margin-bottom:3px;' +
      'font-size:10px;font-weight:800;color:#fff;text-shadow:0 0 3px #000,0 1px 2px #000;' +
      'background:rgba(0,0,0,.55);padding:1px 5px;border-radius:4px;max-width:90px;' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none;line-height:1.2;';
    if (hidden) {
      // Dot center = lat/lng; label floats above (does not affect anchor)
      var dot = 14;
      html =
        '<div class="party-arrow-wrap party-member-hidden-dot" style="position:relative;width:' +
          dot + 'px;height:' + dot + 'px;pointer-events:auto;">' +
          '<div style="' + labelCss + 'font-size:9px;max-width:72px;">' + name + '</div>' +
          '<div style="width:' + dot + 'px;height:' + dot + 'px;border-radius:50%;background:#ffffff;border:3px solid ' +
            c + ';box-shadow:0 1px 4px rgba(0,0,0,0.45);box-sizing:border-box;"></div>' +
        '</div>';
      return L.divIcon({
        className: 'party-presence-icon party-presence-hidden',
        html: html,
        iconSize: [dot, dot],
        iconAnchor: [dot / 2, dot / 2]
      });
    }
    var s = sizePx != null && !isNaN(sizePx) ? Math.round(sizePx) : 30;
    s = Math.max(14, Math.min(56, s));
    var ic = getDirIconById(iconId);
    // Glyph box size (custom = square s×s; default triangle slightly taller)
    var gw = ic ? s : Math.round(s * 0.8);
    var gh = ic ? s : Math.round(s * 1.13);
    var body = buildDirBodyHtml(c, heading, iconId, s);
    html =
      '<div class="party-arrow-wrap" style="position:relative;width:' + gw + 'px;height:' + gh +
        'px;pointer-events:auto;overflow:visible;">' +
        '<div class="party-arrow-label" style="' + labelCss + '">' + name + '</div>' +
        body +
      '</div>';
    return L.divIcon({
      className: 'party-presence-icon',
      html: html,
      iconSize: [gw, gh],
      // Exact GPS point = center of directional glyph (matches own-location arrow)
      iconAnchor: [gw / 2, gh / 2]
    });
  }

  function partyIconForMember(mem, heading) {
    return buildPartyArrowIcon(
      memberColor(mem),
      memberLabel(mem),
      heading,
      memberDirIconId(mem),
      memberIconSizePx(mem),
      memberMarkerHidden(mem)
    );
  }

  /**
   * Picker-only: rotate so the icon's "front" (frontDeg) faces up.
   * Map uses rotate(heading − frontDeg); upright preview = rotate(−frontDeg).
   */
  function dirIconUprightPreview(iconId, hex, size) {
    var ic = getDirIconById(iconId);
    if (!ic) return '';
    var front = (ic.frontDeg != null && !isNaN(ic.frontDeg)) ? Number(ic.frontDeg) : 0;
    var upright = ((-front) % 360 + 360) % 360;
    return (
      '<span class="dir-upright-wrap" style="display:inline-flex;align-items:center;justify-content:center;' +
        'transform:rotate(' + upright.toFixed(1) + 'deg);transform-origin:center center;line-height:0;" ' +
        'title="Front points up (frontDeg ' + front + ')">' +
        dirIconColoredMarkup(iconId, hex, size) +
      '</span>'
    );
  }

  var _dirPickerScale = 1; // 0.4–1.6 from size slider in picker
  function updateDirIconLivePreview() {
    var box = $('dir-icon-live-preview');
    if (!box) return;
    var c = normalizeDirHex(_dirPickerColor || '#e11d1d');
    var s = Math.round(Math.max(18, Math.min(56, 36 * (_dirPickerScale || 1))));
    // Grow preview box slightly with scale so large icons aren't clipped
    var boxS = Math.max(44, s + 10);
    box.style.width = boxS + 'px';
    box.style.height = boxS + 'px';
    if (_dirPickerSelected) {
      // Always nose-up so orientation is easy to verify
      box.innerHTML = dirIconUprightPreview(_dirPickerSelected, c, s);
    } else {
      // Match map default GPS arrow (same paths as buildGpsMarkerIcon) — tip already up
      var aw = Math.round(s * 0.78);
      var ah = Math.round(s * 1.0);
      box.innerHTML =
        '<svg class="dir-default-map-arrow" viewBox="0 0 24 32" width="' + aw + '" height="' + ah +
          '" aria-hidden="true" style="display:block;">' +
          '<path d="M12 1.5 L22.5 29.5 L12 23.2 L1.5 29.5 Z" fill="' + c +
            '" stroke="#000" stroke-width="0.9" stroke-linejoin="round" stroke-linecap="round"/>' +
          '<path d="M12 6.5 L17.2 24.5 L12 20.5 L6.8 24.5 Z" fill="' + c + '" opacity="0.35"/>' +
        '</svg>';
    }
  }
  window.onDirIconPickerSizeChange = function (val) {
    var pct = parseInt(val, 10) || 100;
    pct = Math.max(40, Math.min(160, pct));
    _dirPickerScale = pct / 100;
    var lab = $('dir-icon-size-val');
    if (lab) lab.textContent = String(pct);
    try { updateDirIconLivePreview(); } catch (e) {}
    // Live-update Change marker button preview if open under the edit modal
    try {
      if (typeof window.rsRefreshChangeMarkerBtn === 'function') {
        window.rsRefreshChangeMarkerBtn({
          iconId: _dirPickerSelected,
          color: _dirPickerColor,
          scale: _dirPickerScale
        });
      }
    } catch (e2) {}
  };

  function renderDirIconPickerGrid(selectedId) {
    var grid = $('dir-icon-grid');
    if (!grid) return;
    var q = (($('dir-icon-search') && $('dir-icon-search').value) || '').trim().toLowerCase();
    var list = DIR_ICON_CATALOG.filter(function (ic) {
      if (!q) return true;
      return ic.name.toLowerCase().indexOf(q) >= 0 || ic.id.indexOf(q) >= 0;
    });
    // Friend mode: first tile = "use their profile default"; self mode = red triangle
    var defTitle = _dirPickerMode === 'friend' ? 'Use their default' : 'Default triangle';
    var c = normalizeDirHex(_dirPickerColor || '#e11d1d');
    var html = '';
    var defSel = !selectedId;
    // Same chevron path as map GPS marker (buildGpsMarkerIcon)
    var defaultArrowSvg =
      '<svg class="dir-default-map-arrow" viewBox="0 0 24 32" width="28" height="36" aria-hidden="true" style="display:block;">' +
        '<path d="M12 1.5 L22.5 29.5 L12 23.2 L1.5 29.5 Z" fill="' + c +
          '" stroke="#000" stroke-width="0.9" stroke-linejoin="round" stroke-linecap="round"/>' +
        '<path d="M12 6.5 L17.2 24.5 L12 20.5 L6.8 24.5 Z" fill="' + c + '" opacity="0.35"/>' +
      '</svg>';
    html += '<button type="button" class="dir-icon-cell' + (defSel ? ' selected' : '') +
      '" data-id="" title="' + esc(defTitle) + '" aria-label="' + esc(defTitle) + '">' +
      '<span class="dir-cell-glyph">' + defaultArrowSvg + '</span></button>';
    list.forEach(function (ic) {
      var sel = selectedId === ic.id;
      // All custom icons drawn nose-up so frontDeg can be checked at a glance
      html += '<button type="button" class="dir-icon-cell' + (sel ? ' selected' : '') +
        '" data-id="' + esc(ic.id) + '" data-name="' + esc(ic.name) +
        '" title="' + esc(ic.name) + ' (front up)" aria-label="' + esc(ic.name) + '">' +
        '<span class="dir-cell-glyph">' + dirIconUprightPreview(ic.id, c, 40) + '</span></button>';
    });
    grid.innerHTML = html;
    grid.querySelectorAll('.dir-icon-cell').forEach(function (btn) {
      btn.onclick = function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var id = btn.getAttribute('data-id') || '';
        _dirPickerSelected = id || null;
        grid.querySelectorAll('.dir-icon-cell').forEach(function (b) {
          b.classList.toggle('selected', (b.getAttribute('data-id') || '') === id);
        });
        updateDirIconLivePreview();
      };
    });
    updateDirIconLivePreview();
  }

  var _dirPickerMode = 'self'; // 'self' | 'friend'
  window.onDirIconPickerColorChange = function (hex) {
    _dirPickerColor = normalizeDirHex(hex);
    // Live-tint thumbs + preview without full grid rebuild if possible
    try { renderDirIconPickerGrid(_dirPickerSelected); } catch (e) {
      try { updateDirIconLivePreview(); } catch (e2) {}
    }
    try {
      if (typeof window.rsRefreshChangeMarkerBtn === 'function') {
        window.rsRefreshChangeMarkerBtn({
          iconId: _dirPickerSelected,
          color: _dirPickerColor,
          scale: _dirPickerScale
        });
      }
    } catch (e3) {}
  };
  function wireDirIconColorPicker() {
    var root = $('cp-dir-icon');
    if (!root) return;
    // Ensure picker is built (shared color-picker system in index.html)
    try {
      if (typeof initAllColorPickers === 'function') initAllColorPickers();
    } catch (eI) {}
    try {
      if (typeof setColorPickerValue === 'function') {
        setColorPickerValue(root, normalizeDirHex(_dirPickerColor), { silent: true });
      }
    } catch (eS) {}
    var hv = $('dir-icon-color-value');
    if (hv) hv.value = normalizeDirHex(_dirPickerColor);
  }
  function openDirIconPicker(opts) {
    opts = opts || {};
    _dirPickerOnPick = typeof opts.onPick === 'function' ? opts.onPick : null;
    _dirPickerSelected = opts.currentId || null;
    _dirPickerColor = normalizeDirHex(opts.currentColor || myArrowColor || '#e11d1d');
    var sc = opts.currentScale != null ? Number(opts.currentScale) : 1;
    if (isNaN(sc) || sc <= 0) sc = 1;
    _dirPickerScale = Math.max(0.4, Math.min(1.6, sc));
    _dirPickerMode = opts.mode === 'friend' ? 'friend' : 'self';
    var modal = $('dir-icon-picker-modal');
    if (!modal) return;
    var title = $('dir-icon-picker-title');
    if (title) title.textContent = opts.title || 'Choose direction icon';
    var search = $('dir-icon-search');
    if (search) search.value = '';
    var hv = $('dir-icon-color-value');
    if (hv) hv.value = _dirPickerColor;
    var sizeEl = $('dir-icon-size');
    var sizeLab = $('dir-icon-size-val');
    var pct = Math.round(_dirPickerScale * 100);
    if (sizeEl) sizeEl.value = String(pct);
    if (sizeLab) sizeLab.textContent = String(pct);
    wireDirIconColorPicker();
    renderDirIconPickerGrid(_dirPickerSelected);
    modal.classList.add('active');
    modal.removeAttribute('hidden');
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
  }
  function closeDirIconPicker() {
    var modal = $('dir-icon-picker-modal');
    if (modal) {
      modal.classList.remove('active');
      modal.style.display = 'none';
      modal.setAttribute('hidden', '');
      modal.setAttribute('aria-hidden', 'true');
    }
    _dirPickerOnPick = null;
  }
  function confirmDirIconPicker() {
    var id = _dirPickerSelected || null;
    var color = normalizeDirHex(_dirPickerColor || '#e11d1d');
    var scale = Math.max(0.4, Math.min(1.6, _dirPickerScale || 1));
    var cb = _dirPickerOnPick;
    closeDirIconPicker();
    if (cb) {
      try { cb(id, color, scale); } catch (e) { console.warn(e); }
    }
  }
  window.openDirIconPicker = openDirIconPicker;
  window.closeDirIconPicker = closeDirIconPicker;
  window.confirmDirIconPicker = confirmDirIconPicker;
  window.renderDirIconPickerGrid = function () {
    renderDirIconPickerGrid(_dirPickerSelected);
  };

  /** Smooth in-place rotation without full icon rebuild when possible. */
  function updatePartyMarkerHeading(uid, heading) {
    var mk = partyMarkers[uid];
    if (!mk) return;
    heading = normalizeHeading(heading);
    if (heading == null) return;
    try {
      var el = mk.getElement && mk.getElement();
      if (el) {
        var rot = el.querySelector('.party-arrow-rot');
        if (rot) {
          var front = parseFloat(rot.getAttribute('data-front') || '0');
          if (isNaN(front)) front = 0;
          var cssRot = ((heading - front) % 360 + 360) % 360;
          rot.style.transform = 'rotate(' + cssRot.toFixed(1) + 'deg)';
          mk._rsHeading = heading;
          return;
        }
      }
    } catch (e) {}
    // Hidden dots have no rotator — skip rebuild on heading-only ticks
    try {
      if (mk._rsHidden) {
        mk._rsHeading = heading;
        return;
      }
    } catch (eH) {}
    // Fallback: rebuild icon
    try {
      var mem = (window.__rsPartyMembers || []).find(function (x) { return String(x.user_id) === String(uid); }) ||
        { user_id: uid, username: 'Hunter' };
      var icon = partyIconForMember(mem, heading);
      mk.setIcon(icon);
      mk._rsHeading = heading;
      mk._rsHidden = memberMarkerHidden(mem);
    } catch (e2) {}
  }

  function formatAgo(iso) {
    if (!iso) return 'unknown';
    var t = new Date(iso).getTime();
    if (isNaN(t)) return 'unknown';
    var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }

  function escJs(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/"/g, '\\"')
      .replace(/\n/g, ' ');
  }

  /**
   * Party member popup: last update, Hide/Unhide, Edit friend, Save pin — no facing degrees.
   */
  function buildPartyMemberPopupHtml(row, mem) {
    var uid = String(row.user_id);
    var label = memberLabel(mem);
    var lat = Number(row.lat);
    var lng = Number(row.lng);
    var isHidden = memberMarkerHidden(mem);
    return (
      '<div class="map-dot-menu party-member-popup" onclick="event.stopPropagation();">' +
        '<div class="mdm-title">' + esc(label) + (isHidden ? ' <span style="opacity:.75;font-weight:600;">(hidden)</span>' : '') + '</div>' +
        '<div class="mdm-sub" style="margin:4px 0 10px;">Last update: <strong>' +
          esc(formatAgo(row.updated_at)) + '</strong></div>' +
        '<button type="button" class="mdm-btn hide-friend' + (isHidden ? ' is-hidden' : '') + '" ' +
          'onclick="event.preventDefault();event.stopPropagation();' +
          'window.rsTogglePartyFriendHidden&&window.rsTogglePartyFriendHidden(\'' + escJs(uid) + '\');return false;">' +
          (isHidden ? 'Unhide' : 'Hide') + '</button>' +
        '<button type="button" class="mdm-btn pin" ' +
          'onclick="event.preventDefault();event.stopPropagation();' +
          'window.rsEditPartyFriend&&window.rsEditPartyFriend(\'' + escJs(uid) + '\');return false;">' +
          'Edit friend</button>' +
        '<button type="button" class="mdm-btn save-pin" ' +
          'onclick="event.preventDefault();event.stopPropagation();' +
          'window.rsSavePartyPin&&window.rsSavePartyPin(\'' + escJs(uid) + '\',' +
          lat + ',' + lng + ',\'' + escJs(label) + '\');return false;">' +
          'Save pin</button>' +
      '</div>'
    );
  }

  function findPartyMember(uid) {
    var members = window.__rsPartyMembers || [];
    uid = String(uid);
    for (var i = 0; i < members.length; i++) {
      if (String(members[i].user_id) === uid) return members[i];
    }
    return { user_id: uid, username: 'Hunter', display_name: 'Hunter' };
  }

  window.rsTogglePartyFriendHidden = function (uid) {
    uid = String(uid || '');
    if (!uid) return Promise.resolve();
    var pref = getPartyPref(uid);
    var next = !pref.marker_hidden;
    return savePartyPref(uid, { marker_hidden: next }).then(function () {
      rebuildPartyMemberIcon(uid);
      try {
        var mk = partyMarkers[uid] || partyMarkers[prefKey(uid)];
        if (mk && mk.getPopup) {
          var mem = findPartyMember(uid);
          var ll = mk.getLatLng && mk.getLatLng();
          var row = {
            user_id: uid,
            lat: ll ? ll.lat : null,
            lng: ll ? ll.lng : null,
            updated_at: mk._rsUpdatedAt || new Date().toISOString()
          };
          mk.setPopupContent(buildPartyMemberPopupHtml(row, mem));
          // Keep popup open after hide/unhide so user can confirm state
          try { if (!mk.isPopupOpen || !mk.isPopupOpen()) mk.openPopup(); } catch (eO) {}
        }
      } catch (eP) {}
      try {
        if (window.showAppCopyToast) {
          showAppCopyToast(next
            ? '<span class="act">Hidden</span><br>Shows as a color dot on your map'
            : '<span class="act">Unhidden</span><br>Full direction icon restored');
        }
      } catch (eT) {}
    }).catch(function (err) {
      console.warn('rsTogglePartyFriendHidden', err);
    });
  };

  /** Markup for the Change marker button (icon + color + size preview). */
  function changeMarkerBtnInnerHtml(iconId, color, scale, mode) {
    var c = normalizeDirHex(color || '#2563eb');
    var sc = scale != null && !isNaN(scale) ? Number(scale) : 1;
    sc = Math.max(0.4, Math.min(1.6, sc));
    var px = Math.round(18 * sc);
    px = Math.max(12, Math.min(32, px));
    var glyph;
    if (iconId && getDirIconById(iconId)) {
      glyph = dirIconUprightPreview(iconId, c, px);
    } else {
      var aw = Math.round(px * 0.75);
      var ah = Math.round(px * 1.05);
      glyph =
        '<svg viewBox="0 0 24 32" width="' + aw + '" height="' + ah +
          '" aria-hidden="true" style="display:block;">' +
          '<path d="M12 1.5 L22.5 29.5 L12 23.2 L1.5 29.5 Z" fill="' + c +
            '" stroke="#000" stroke-width="0.9" stroke-linejoin="round"/>' +
        '</svg>';
    }
    var pct = Math.round(sc * 100);
    var sub = mode === 'friend' && !iconId
      ? 'Their default · ' + pct + '%'
      : (iconId ? ((getDirIconById(iconId) || {}).name || iconId) : 'Default') + ' · ' + pct + '%';
    return (
      '<span style="display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;">' +
        '<span style="flex:0 0 auto;width:36px;height:36px;display:flex;align-items:center;justify-content:center;' +
          'background:rgba(0,0,0,0.25);border-radius:7px;border:1px solid #333;overflow:hidden;">' +
          glyph +
        '</span>' +
        '<span style="flex:1;min-width:0;text-align:left;">' +
          '<span style="display:block;font-weight:800;font-size:11px;color:#fff;">Change marker</span>' +
          '<span style="display:block;font-size:9px;color:#a8b49c;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
            esc(sub) +
          '</span>' +
        '</span>' +
      '</span>'
    );
  }

  function readEditFormMarkerState(prefix) {
    prefix = prefix || 'rs-friend';
    var dEl = document.getElementById(prefix + '-dir');
    var cEl = document.getElementById(prefix + '-color');
    var sEl = document.getElementById(prefix + '-size');
    var id = dEl && dEl.value ? dEl.value : null;
    var color = cEl ? cEl.value : '#2563eb';
    var pct = sEl ? (parseInt(sEl.value, 10) || 100) : 100;
    pct = Math.max(40, Math.min(160, pct));
    return { iconId: id || null, color: color, scale: pct / 100, pct: pct };
  }

  window.rsRefreshChangeMarkerBtn = function (override) {
    var btn = document.getElementById('rs-friend-dir-btn') || document.getElementById('rs-mem-dir-btn');
    if (!btn) return;
    var prefix = document.getElementById('rs-friend-dir-btn') ? 'rs-friend' : 'rs-mem';
    var st = readEditFormMarkerState(prefix);
    if (override) {
      if (override.iconId !== undefined) st.iconId = override.iconId || null;
      if (override.color) st.color = override.color;
      if (override.scale != null) st.scale = override.scale;
    }
    // Keep hidden size field in sync while slider moves in picker
    var sEl = document.getElementById(prefix + '-size');
    if (sEl && override && override.scale != null) {
      sEl.value = String(Math.round(st.scale * 100));
    }
    var mode = btn.getAttribute('data-mode') || 'friend';
    btn.innerHTML = changeMarkerBtnInnerHtml(st.iconId, st.color, st.scale, mode);
  };

  function wireFriendEditForm(opts) {
    opts = opts || {};
    var prefix = opts.prefix || 'rs-friend';
    var mode = opts.mode || 'friend';
    var titleBase = opts.titleBase || 'Friend';
    var uid = opts.uid || null;
    var isSelf = !!opts.isSelf;

    // Nickname button toggles text field
    var nickBtn = document.getElementById(prefix + '-nick-btn');
    var nickInput = document.getElementById(prefix + '-nick');
    var titleEl = document.querySelector('#rs-simple-modal h3');
    function syncTitleFromNick() {
      if (!titleEl || isSelf) return;
      var n = nickInput ? String(nickInput.value || '').trim() : '';
      titleEl.textContent = n
        ? (n + ' — ' + titleBase)
        : ((prefix === 'rs-mem' ? 'Customize ' : 'Edit friend — ') + titleBase);
    }
    if (nickBtn && nickInput) {
      nickBtn.onclick = function (ev) {
        if (ev) { ev.preventDefault(); ev.stopPropagation(); }
        var open = nickInput.style.display !== 'none';
        nickInput.style.display = open ? 'none' : 'block';
        if (!open) {
          try { nickInput.focus(); } catch (eF) {}
        } else {
          var n = String(nickInput.value || '').trim();
          nickBtn.textContent = n ? ('Nickname: ' + n) : 'Nickname';
          syncTitleFromNick();
        }
      };
      nickInput.addEventListener('input', function () {
        var n = String(nickInput.value || '').trim();
        nickBtn.textContent = n ? ('Nickname: ' + n) : 'Nickname';
        syncTitleFromNick();
      });
      nickInput.addEventListener('blur', function () {
        // Collapse after edit; keep name on button + title
        nickInput.style.display = 'none';
        var n = String(nickInput.value || '').trim();
        nickBtn.textContent = n ? ('Nickname: ' + n) : 'Nickname';
        syncTitleFromNick();
      });
    }

    // Color live-updates Change marker preview
    var cEl = document.getElementById(prefix + '-color');
    if (cEl) {
      cEl.addEventListener('input', function () {
        window.rsRefreshChangeMarkerBtn({ color: cEl.value });
      });
    }

    // Change marker → icon picker with size + color
    var dirBtn = document.getElementById(prefix + '-dir-btn');
    if (dirBtn) {
      dirBtn.setAttribute('data-mode', mode);
      dirBtn.onclick = function (ev) {
        if (ev) { ev.preventDefault(); ev.stopPropagation(); }
        var st = readEditFormMarkerState(prefix);
        openDirIconPicker({
          title: isSelf ? 'Your location marker' : ('Change marker — ' + titleBase),
          currentId: st.iconId,
          currentColor: st.color,
          currentScale: st.scale,
          mode: isSelf ? 'self' : 'friend',
          onPick: function (id, color, scale) {
            var hid = document.getElementById(prefix + '-dir');
            var sizeH = document.getElementById(prefix + '-size');
            var colEl = document.getElementById(prefix + '-color');
            if (hid) hid.value = id || '';
            if (sizeH) sizeH.value = String(Math.round((scale || 1) * 100));
            if (colEl && color) colEl.value = color;
            window.rsRefreshChangeMarkerBtn({
              iconId: id || null,
              color: color || st.color,
              scale: scale != null ? scale : st.scale
            });
          }
        });
      };
    }

    // Hide (friends only)
    var hideBtn = document.getElementById(prefix + '-hide-btn');
    if (hideBtn && uid && !isSelf) {
      hideBtn.onclick = function (ev) {
        if (ev) { ev.preventDefault(); ev.stopPropagation(); }
        var next = !getPartyPref(uid).marker_hidden;
        var st = readEditFormMarkerState(prefix);
        var nEl = document.getElementById(prefix + '-nick');
        var n = nEl ? String(nEl.value || '').trim() : '';
        savePartyPref(uid, {
          nickname: n || null,
          arrow_color: st.color,
          direction_icon_id: st.iconId,
          icon_scale: st.scale,
          marker_hidden: next
        }).then(function () {
          rebuildPartyMemberIcon(uid);
          try {
            var modal = document.getElementById('rs-simple-modal');
            if (modal && modal.parentNode) modal.remove();
          } catch (eClose) {}
          try {
            if (window.showAppCopyToast) {
              showAppCopyToast(next
                ? '<span class="act">Hidden</span><br>Shows as a color dot on your map'
                : '<span class="act">Unhidden</span><br>Full direction icon restored');
            }
          } catch (eT) {}
        }).catch(function (err) {
          console.warn('edit friend hide', err);
        });
      };
    }
  }

  window.rsEditPartyFriend = function (uid) {
    uid = String(uid || '');
    if (!uid) return;
    var mem = findPartyMember(uid);
    var pref = partyPrefs[uid] || partyPrefs[mem.user_id] || getPartyPref(uid) || {};
    var nick = pref.nickname || '';
    var col = pref.arrow_color || mem.arrow_color || memberColor(mem) || '#2563eb';
    var dirId = (Object.prototype.hasOwnProperty.call(pref, 'direction_icon_id') && pref.direction_icon_id)
      ? pref.direction_icon_id
      : null;
    var scale = memberIconScale(mem);
    var scalePct = Math.round(scale * 100);
    var isHidden = !!pref.marker_hidden;
    var baseName = mem.display_name || mem.username || 'Hunter';
    var title = nick ? (nick + ' — ' + baseName) : ('Edit friend — ' + baseName);
    var body =
      '<div style="display:flex;align-items:center;gap:6px;margin:0 0 6px;">' +
        '<button type="button" class="settings-subbtn" id="rs-friend-nick-btn" style="flex:1;margin:0;text-align:left;padding:7px 8px;">' +
          (nick ? ('Nickname: ' + esc(nick)) : 'Nickname') +
        '</button>' +
        '<input type="color" id="rs-friend-color" value="' + esc(col) + '" title="Marker color" ' +
          'style="width:42px;height:36px;padding:0;border:1px solid #444;border-radius:8px;background:transparent;cursor:pointer;flex:0 0 auto;">' +
      '</div>' +
      '<input type="text" id="rs-friend-nick" maxlength="32" value="' + esc(nick) + '" placeholder="Type a nickname…" ' +
        'style="display:none;width:100%;box-sizing:border-box;padding:7px;border-radius:6px;border:1px solid #444;background:#1a1a1a;color:#fff;margin:0 0 6px;font-size:12px;">' +
      '<button type="button" class="settings-subbtn" id="rs-friend-dir-btn" data-mode="friend" style="width:100%;margin:0 0 6px;padding:6px 8px;">' +
        changeMarkerBtnInnerHtml(dirId, col, scale, 'friend') +
      '</button>' +
      '<input type="hidden" id="rs-friend-dir" value="' + esc(dirId || '') + '">' +
      '<input type="hidden" id="rs-friend-size" value="' + scalePct + '">' +
      '<button type="button" class="settings-subbtn" id="rs-friend-hide-btn" style="width:100%;margin:0;padding:7px 8px;' +
        (isHidden ? 'background:#1a4a5c;border-color:#2a6a7c;' : '') + '">' +
        (isHidden ? 'Unhide' : 'Hide') + '</button>';
    showSimpleModal(title, body, [
      {
        label: 'Save',
        primary: true,
        onClick: function () {
          var nEl = document.getElementById('rs-friend-nick');
          var st = readEditFormMarkerState('rs-friend');
          var n = nEl ? String(nEl.value || '').trim() : '';
          return savePartyPref(uid, {
            nickname: n || null,
            arrow_color: st.color,
            direction_icon_id: st.iconId,
            icon_scale: st.scale
          }).then(function () {
            rebuildPartyMemberIcon(uid);
            setTimeout(function () {
              try { pullPresence(); } catch (eP) {}
            }, 50);
            try {
              if (window.showAppCopyToast) {
                showAppCopyToast('<span class="act">Friend updated</span><br>' +
                  esc(n || baseName) + ' · ' + st.pct + '%');
              }
            } catch (eT) {}
          });
        }
      },
      { label: 'Cancel' }
    ], { compact: true });
    setTimeout(function () {
      wireFriendEditForm({
        prefix: 'rs-friend',
        mode: 'friend',
        titleBase: baseName,
        uid: uid,
        isSelf: false
      });
    }, 30);
    try {
      var m = getMap();
      if (m) m.closePopup();
    } catch (eC) {}
  };

  /** Edit your own live location marker (from GPS pin popup). */
  window.openEditOwnMarker = function () {
    var col = myArrowColor || '#e11d1d';
    var dirId = myDirIconId || null;
    var scale = myDirIconScale || 1;
    var scalePct = Math.round(scale * 100);
    var body =
      '<div style="display:flex;align-items:center;gap:6px;margin:0 0 6px;">' +
        '<span class="settings-hint" style="flex:1;margin:0;font-size:11px;font-weight:700;">Marker color</span>' +
        '<input type="color" id="rs-friend-color" value="' + esc(col) + '" title="Marker color" ' +
          'style="width:42px;height:36px;padding:0;border:1px solid #444;border-radius:8px;background:transparent;cursor:pointer;flex:0 0 auto;">' +
      '</div>' +
      '<button type="button" class="settings-subbtn" id="rs-friend-dir-btn" data-mode="self" style="width:100%;margin:0;padding:6px 8px;">' +
        changeMarkerBtnInnerHtml(dirId, col, scale, 'self') +
      '</button>' +
      '<input type="hidden" id="rs-friend-dir" value="' + esc(dirId || '') + '">' +
      '<input type="hidden" id="rs-friend-size" value="' + scalePct + '">';
    showSimpleModal('Edit your marker', body, [
      {
        label: 'Save',
        primary: true,
        onClick: function () {
          var st = readEditFormMarkerState('rs-friend');
          myArrowColor = st.color || myArrowColor;
          myDirIconId = st.iconId || null;
          myDirIconScale = st.scale;
          try {
            localStorage.setItem(ARROW_KEY, myArrowColor);
            if (myDirIconId) localStorage.setItem(DIR_ICON_KEY, myDirIconId);
            else localStorage.removeItem(DIR_ICON_KEY);
            localStorage.setItem(DIR_SCALE_KEY, String(myDirIconScale));
          } catch (eL) {}
          try { document.documentElement.style.setProperty('--gps-arrow-color', myArrowColor); } catch (eCss) {}
          try {
            var sb = getSb() || window.__rsSb;
            var user = getUser() || window.__rsUser;
            if (sb && user) {
              sb.from('profiles').update({
                direction_icon_id: myDirIconId,
                arrow_color: myArrowColor
              }).eq('id', user.id).then(function () {});
            }
          } catch (eP) {}
          try { syncMyDirIconSettingsBtn(); } catch (eB) {}
          try {
            if (typeof setGpsMarker === 'function' && typeof userLat !== 'undefined' && userLat != null) {
              setGpsMarker(userLat, userLng);
            }
          } catch (eG) {}
          try {
            if (window.showAppCopyToast) {
              showAppCopyToast('<span class="act">Marker updated</span><br>' + st.pct + '% · ' +
                esc(myDirIconId ? ((getDirIconById(myDirIconId) || {}).name || myDirIconId) : 'Default'));
            }
          } catch (eT) {}
        }
      },
      { label: 'Cancel' }
    ], { compact: true });
    setTimeout(function () {
      wireFriendEditForm({
        prefix: 'rs-friend',
        mode: 'self',
        titleBase: 'You',
        isSelf: true
      });
    }, 30);
    try {
      var m = getMap();
      if (m) m.closePopup();
    } catch (eC) {}
  };

  window.rsSavePartyPin = function (uid, lat, lng, label) {
    lat = Number(lat);
    lng = Number(lng);
    if (isNaN(lat) || isNaN(lng)) {
      alert('Location not available.');
      return;
    }
    var mem = findPartyMember(uid);
    var name = (label || memberLabel(mem) || 'Party member') + ' location';
    var color = memberColor(mem) || '#2563eb';
    var pin = {
      id: 'pin_party_' + Date.now() + '_' + Math.floor(Math.random() * 999),
      name: name,
      lat: lat,
      lng: lng,
      isPin: true,
      color: color,
      notes: 'Saved from party live location',
      createdAt: new Date().toISOString()
    };
    stampOwner(pin);
    try {
      if (typeof locations !== 'undefined' && Array.isArray(locations)) {
        locations.push(pin);
      }
    } catch (eL) {}
    try {
      var pins = JSON.parse(localStorage.getItem('alabama_hunt_custom_pins') || '[]');
      if (!Array.isArray(pins)) pins = [];
      pins.push(pin);
      localStorage.setItem('alabama_hunt_custom_pins', JSON.stringify(pins));
    } catch (eS) {
      alert('Could not save pin on this device.');
      return;
    }
    try {
      if (typeof drawPinsOnMap === 'function') drawPinsOnMap();
    } catch (eD) {}
    try {
      if (typeof window.regSlayerMapDataChanged === 'function') window.regSlayerMapDataChanged();
    } catch (eM) {}
    try {
      var m = getMap();
      if (m) m.closePopup();
    } catch (eC) {}
    try {
      if (window.showAppCopyToast) {
        showAppCopyToast('<span class="act">Pin saved</span><br>' + esc(name));
      } else {
        alert('Pin saved: ' + name);
      }
    } catch (eT) {}
  };

  function partyPrefsLocalStoreKey(mapId) {
    var user = getUser() || window.__rsUser;
    var uid = user ? (user.id || user.user_id || '') : '';
    return PARTY_PREFS_LOCAL_KEY + ':' + String(mapId || '') + ':' + String(uid || '');
  }
  function loadPartyPrefsLocal(mapId) {
    try {
      var raw = localStorage.getItem(partyPrefsLocalStoreKey(mapId));
      var o = raw ? JSON.parse(raw) : {};
      return o && typeof o === 'object' ? o : {};
    } catch (e) {
      return {};
    }
  }
  function savePartyPrefsLocal(mapId, allPrefsByMember) {
    try {
      localStorage.setItem(partyPrefsLocalStoreKey(mapId), JSON.stringify(allPrefsByMember || {}));
    } catch (e) {}
  }
  function persistPartyPrefLocal(mapId, memberId, fields) {
    var store = loadPartyPrefsLocal(mapId);
    var mid = prefKey(memberId);
    store[mid] = Object.assign({}, store[mid] || {}, fields || {});
    savePartyPrefsLocal(mapId, store);
  }

  async function loadPartyPrefs(mapId) {
    partyPrefs = {};
    var sb = getSb() || window.__rsSb;
    var user = getUser() || window.__rsUser;
    if (!mapId) return;
    // 1) Local overrides first (survive cloud reload / missing migration)
    var local = loadPartyPrefsLocal(mapId);
    Object.keys(local).forEach(function (mid) {
      partyPrefs[mid] = Object.assign({}, local[mid]);
      partyPrefs[mid] = partyPrefs[mid];
    });
    if (!sb || !user) return;
    try {
      // Prefer full select; fall back if direction_icon_id column not migrated yet
      var res = await sb.from('party_member_prefs')
        .select('member_user_id, nickname, arrow_color, show_content, direction_icon_id')
        .eq('map_id', mapId)
        .eq('owner_user_id', user.id);
      if (res.error) {
        res = await sb.from('party_member_prefs')
          .select('member_user_id, nickname, arrow_color, show_content')
          .eq('map_id', mapId)
          .eq('owner_user_id', user.id);
      }
      (res.data || []).forEach(function (r) {
        var k = prefKey(r.member_user_id);
        // Cloud base, then local wins for direction_icon_id / nick / color if set locally later
        var merged = Object.assign({}, r, local[k] || {});
        // If cloud has direction_icon_id and local doesn't, keep cloud
        if (!Object.prototype.hasOwnProperty.call(local[k] || {}, 'direction_icon_id') &&
            r.direction_icon_id != null) {
          merged.direction_icon_id = r.direction_icon_id;
        }
        partyPrefs[k] = merged;
        partyPrefs[r.member_user_id] = merged;
      });
    } catch (e) {
      console.warn('loadPartyPrefs', e);
    }
    try {
      hiddenContentOwners = JSON.parse(localStorage.getItem(HIDDEN_MEMBERS_KEY + ':' + mapId) || '{}');
    } catch (e2) { hiddenContentOwners = {}; }
  }

  /** Columns that exist on party_member_prefs; icon_scale / marker_hidden stay local-only. */
  var PARTY_PREF_CLOUD_KEYS = {
    nickname: true,
    arrow_color: true,
    show_content: true,
    direction_icon_id: true
  };

  async function savePartyPref(memberId, fields, mapIdOpt) {
    var sb = getSb() || window.__rsSb;
    var user = getUser() || window.__rsUser;
    var vs = C.getViewState && C.getViewState();
    var mapId = mapIdOpt || (vs && vs.mode === 'shared' ? vs.sharedMapId : null) ||
      (mapsUiSelected && mapsUiSelected.kind === 'shared' ? mapsUiSelected.id : null);
    if (!mapId) {
      throw new Error('Not on a shared map — open the map first, then edit this hunter.');
    }
    var mid = prefKey(memberId);
    // Always update memory + localStorage first (map redraw must not depend on cloud)
    partyPrefs[mid] = Object.assign({}, getPartyPref(mid), fields);
    partyPrefs[memberId] = partyPrefs[mid];
    persistPartyPrefLocal(mapId, mid, fields);

    if (!sb || !user) return partyPrefs[mid];

    var cloudFields = {};
    Object.keys(fields || {}).forEach(function (k) {
      if (PARTY_PREF_CLOUD_KEYS[k]) cloudFields[k] = fields[k];
    });
    // Nothing cloud-worthy (e.g. only icon_scale / marker_hidden) — local is enough
    if (!Object.keys(cloudFields).length) return partyPrefs[mid];

    var row = Object.assign({
      map_id: mapId,
      owner_user_id: user.id,
      member_user_id: mid,
      updated_at: new Date().toISOString()
    }, cloudFields);

    var res = await sb.from('party_member_prefs').upsert(row, {
      onConflict: 'map_id,owner_user_id,member_user_id'
    });
    if (res.error) {
      // Retry without direction_icon_id if column not migrated
      if (Object.prototype.hasOwnProperty.call(cloudFields, 'direction_icon_id')) {
        var row2 = Object.assign({}, row);
        delete row2.direction_icon_id;
        var res2 = await sb.from('party_member_prefs').upsert(row2, {
          onConflict: 'map_id,owner_user_id,member_user_id'
        });
        if (res2.error) {
          console.warn('party pref cloud save failed; kept local', res2.error);
        } else {
          console.warn('direction_icon_id not on cloud yet (run migration). Local override still applied.');
        }
      } else {
        console.warn('party pref cloud save failed; kept local', res.error);
      }
    }
    return partyPrefs[mid];
  }

  async function enrichMembersWithProfiles(members) {
    var sb = getSb() || window.__rsSb;
    if (!sb || !members || !members.length) return members || [];
    var need = [];
    members.forEach(function (m) {
      if (!m) return;
      // Always refresh profile direction_icon_id / arrow_color when possible
      if (m.user_id) need.push(m.user_id);
    });
    if (!need.length) return members;
    try {
      var res = await sb.from('profiles')
        .select('id, arrow_color, direction_icon_id, username, display_name')
        .in('id', need);
      if (res.error || !res.data) return members;
      var byId = {};
      res.data.forEach(function (p) {
        byId[prefKey(p.id)] = p;
      });
      members.forEach(function (m) {
        var p = byId[prefKey(m.user_id)];
        if (!p) return;
        if (p.direction_icon_id != null) m.direction_icon_id = p.direction_icon_id;
        if (p.arrow_color) m.arrow_color = p.arrow_color;
        if (p.username && !m.username) m.username = p.username;
        if (p.display_name && !m.display_name) m.display_name = p.display_name;
      });
    } catch (e) {
      console.warn('enrichMembersWithProfiles', e);
    }
    return members;
  }

  async function listMembersForMap(mapId) {
    var sb = getSb() || window.__rsSb;
    if (!mapId || !sb) return [];
    var { data, error } = await sb.rpc('list_shared_map_members', { p_map_id: mapId });
    if (error) throw error;
    var members = data || [];
    await enrichMembersWithProfiles(members);
    return members;
  }

  function memberLabel(m) {
    if (!m) return 'Hunter';
    var pref = getPartyPref(m.user_id);
    if (pref && pref.nickname) return pref.nickname;
    return m.display_name || m.username || 'Hunter';
  }

  function memberColor(m) {
    if (!m) return '#2563eb';
    var pref = getPartyPref(m.user_id);
    if (pref && pref.arrow_color) return pref.arrow_color;
    return m.arrow_color || '#2563eb';
  }

  /** Force rebuild of one party marker’s icon (after edit). */
  function rebuildPartyMemberIcon(uid) {
    uid = prefKey(uid);
    var mk = partyMarkers[uid] || partyMarkers[String(uid)];
    if (!mk) {
      // Marker may use a different key casing — scan
      Object.keys(partyMarkers).forEach(function (k) {
        if (prefKey(k) === uid) mk = partyMarkers[k];
      });
    }
    if (!mk) {
      console.warn('rebuildPartyMemberIcon: no marker for', uid, Object.keys(partyMarkers));
      return;
    }
    var mem = findPartyMember(uid);
    var hdg = mk._rsHeading != null ? mk._rsHeading : 0;
    try {
      var icon = partyIconForMember(mem, hdg);
      mk.setIcon(icon);
      mk._rsIconSig = memberIconSignature(mem);
      mk._rsHeading = hdg;
      mk._rsHidden = memberMarkerHidden(mem);
      // Ensure keyed under string id
      partyMarkers[uid] = mk;
    } catch (e) {
      console.warn('rebuildPartyMemberIcon', e);
    }
  }

  async function pullPresence(opts) {
    opts = opts || {};
    var vs = C.getViewState && C.getViewState();
    var sb = getSb();
    var user = getUser();
    var m = getMap();
    // Keep window.map in sync when the main app only has a local `map` binding
    if (m && !window.map) {
      try { window.map = m; } catch (eWm) {}
    }
    // Private maps / not shared: never poll presence (no party dots)
    if (!vs || vs.mode !== 'shared' || !vs.sharedMapId || !sb || !m) {
      // Don't wipe markers just because map isn't ready yet — only when not on shared
      if (!vs || vs.mode !== 'shared' || !vs.sharedMapId) {
        clearPartyMarkers();
        stopPresenceRealtime();
      }
      return;
    }
    // Only draw peers when the map/app is open (background: no peer pull)
    try {
      if (!opts.force && typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
    } catch (eVis) {}
    var layer = ensurePartyLayer();
    if (!layer) return;
    try {
      // Profiles/icons: throttle (every presence tick was expensive)
      if (!opts.skipMembers) {
        var needMembers = !lastListMembersAt ||
          (Date.now() - lastListMembersAt) >= LIST_MEMBERS_MIN_MS ||
          !(window.__rsPartyMembers && window.__rsPartyMembers.length);
        if (needMembers) {
          try {
            await listMembers();
            lastListMembersAt = Date.now();
          } catch (eMem) {
            console.warn('listMembers', eMem);
          }
        }
      }

      var res = await sb.from('party_presence')
        .select('user_id, is_sharing, lat, lng, heading, updated_at, started_at')
        .eq('map_id', vs.sharedMapId)
        .eq('is_sharing', true);
      if (res.error) {
        console.warn('presence pull error', res.error);
        return;
      }
      var data = res.data || [];
      var members = window.__rsPartyMembers || [];
      var byId = {};
      members.forEach(function (mm) {
        byId[mm.user_id] = mm;
        byId[String(mm.user_id)] = mm;
      });
      var seen = {};
      data.forEach(function (row) {
        if (!row.is_sharing || row.lat == null || row.lng == null) return;
        // Hide self from party layer (own GPS marker is separate)
        if (user && String(row.user_id) === String(user.id)) return;
        // Stale hide (covers ~20s background heartbeats)
        var age = Date.now() - new Date(row.updated_at).getTime();
        if (isNaN(age) || age > PRESENCE_STALE_MS) return;
        var uid = String(row.user_id);
        seen[uid] = true;
        var mem = byId[row.user_id] || byId[uid] ||
          { user_id: row.user_id, username: 'Hunter', display_name: 'Hunter' };
        var label = memberLabel(mem);
        var hdg = normalizeHeading(row.heading);
        var popup = buildPartyMemberPopupHtml(row, mem);
        var sig = memberIconSignature(mem);
        var isHidden = memberMarkerHidden(mem);
        if (partyMarkers[uid]) {
          partyMarkers[uid].setLatLng([row.lat, row.lng]);
          partyMarkers[uid]._rsUpdatedAt = row.updated_at;
          try {
            partyMarkers[uid].setPopupContent(popup);
          } catch (eP) {}
          // Rebuild icon when color/custom glyph/size/hide changed (heading-only path skips setIcon)
          if (partyMarkers[uid]._rsIconSig !== sig) {
            try {
              var iconUp = partyIconForMember(mem, hdg != null ? hdg : partyMarkers[uid]._rsHeading);
              partyMarkers[uid].setIcon(iconUp);
              partyMarkers[uid]._rsIconSig = sig;
              partyMarkers[uid]._rsHidden = isHidden;
            } catch (eIc) {
              console.warn('party icon update', eIc);
            }
          } else if (hdg != null && !isHidden) {
            if (partyMarkers[uid]._rsHeading == null ||
                headingDelta(partyMarkers[uid]._rsHeading, hdg) >= 2) {
              updatePartyMarkerHeading(uid, hdg);
            }
          }
          if (hdg != null) partyMarkers[uid]._rsHeading = hdg;
        } else {
          var icon = partyIconForMember(mem, hdg);
          var mk = L.marker([row.lat, row.lng], { icon: icon, zIndexOffset: 900 }).addTo(layer);
          mk.bindPopup(popup, {
            className: 'map-dot-popup party-member-leaflet-popup',
            closeButton: true,
            autoPan: false,
            maxWidth: 260,
            closeOnClick: false
          });
          mk._rsHeading = hdg;
          mk._rsUserId = uid;
          mk._rsIconSig = sig;
          mk._rsHidden = isHidden;
          mk._rsUpdatedAt = row.updated_at;
          partyMarkers[uid] = mk;
        }
      });
      Object.keys(partyMarkers).forEach(function (uid) {
        if (!seen[uid]) {
          try { layer.removeLayer(partyMarkers[uid]); } catch (e) {}
          delete partyMarkers[uid];
        }
      });
      try { layer.bringToFront(); } catch (eBf) {}
    } catch (e) {
      console.warn('presence pull', e);
    }
  }

  function clearPartyMarkers() {
    if (partyLayer) {
      try { partyLayer.clearLayers(); } catch (e) {}
    }
    partyMarkers = {};
  }

  function currentSharedMapId() {
    try {
      var vs = C.getViewState && C.getViewState();
      if (vs && vs.mode === 'shared' && vs.sharedMapId) return vs.sharedMapId;
    } catch (e) {}
    return null;
  }

  function readSharePref() {
    try {
      var raw = localStorage.getItem(SHARE_PREF_KEY) || localStorage.getItem(PRESENCE_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return null;
      return o;
    } catch (e) { return null; }
  }

  function persistSharePref() {
    try {
      var payload = {
        want: !!shareWanted,
        on: !!shareWanted, // legacy readers
        active: !!sharing,
        started: shareStartedAt || Date.now(),
        lastView: lastMapViewAt || Date.now(),
        mapId: currentSharedMapId() || null
      };
      localStorage.setItem(SHARE_PREF_KEY, JSON.stringify(payload));
      // Keep legacy key in sync for older code paths
      if (shareWanted) localStorage.setItem(PRESENCE_KEY, JSON.stringify(payload));
      else localStorage.removeItem(PRESENCE_KEY);
    } catch (e) {}
  }

  function clearSharePref() {
    shareWanted = false;
    try { localStorage.removeItem(SHARE_PREF_KEY); } catch (e0) {}
    try { localStorage.removeItem(PRESENCE_KEY); } catch (e1) {}
  }

  /** Reset idle timer; resume live share if toggle is still on after auto-pause. */
  function markMapViewed(opts) {
    opts = opts || {};
    lastMapViewAt = Date.now();
    if (shareWanted) persistSharePref();
    // Resume GPS broadcast if user left the toggle on after idle pause
    if (shareWanted && !sharing && !opts.skipResume) {
      var mapId = currentSharedMapId();
      if (mapId && getUser()) {
        try { startSharing({ silent: true, resume: true }); } catch (eR) {}
      }
    }
  }

  /** True when tab/app is not visible (backgrounded). Fully force-closed tabs cannot run JS. */
  function isShareBackgrounded() {
    try {
      return typeof document !== 'undefined' && document.visibilityState === 'hidden';
    } catch (e) {
      return false;
    }
  }

  /**
   * Auto-pause after 1 hour without the map/app being open (visible).
   * While visible the idle clock stays fresh. Backgrounded ≥1h → pause GPS
   * but keep the toolbar toggle preference on (resumes when they reopen).
   * Opening the app again restarts the 1h timer.
   */
  function checkShareIdleTimeout() {
    if (!sharing || !shareWanted) return false;
    try {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        lastMapViewAt = Date.now();
        return false;
      }
    } catch (eV) {}
    var idleFor = Date.now() - (lastMapViewAt || 0);
    if (idleFor >= SHARE_IDLE_MS) {
      stopSharing('idle');
      return true;
    }
    return false;
  }

  function hookMapForShareView(m) {
    if (!m || m._rsShareViewHooked) return;
    m._rsShareViewHooked = true;
    try {
      m.on('movestart zoomstart click dragstart', function () {
        markMapViewed({ skipResume: false });
      });
    } catch (eM) {}
  }

  function wireShareMapViewTracking() {
    if (shareMapViewWired) return;
    shareMapViewWired = true;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        // Reopen app/tab → restart 1h timer and resume full-rate share
        markMapViewed();
        try {
          if (sharing && shareWanted) {
            startShareGpsWatch({ background: false });
            restartShareHeartbeat();
          } else {
            resumeShareGpsWatchIfNeeded();
          }
        } catch (eR) {}
      } else if (shareWanted || sharing) {
        // Leave app: start idle clock, keep tracking at ~20s (cheaper data/battery)
        lastMapViewAt = Date.now();
        persistSharePref();
        try {
          if (sharing) {
            startShareGpsWatch({ background: true });
            restartShareHeartbeat();
          }
        } catch (eP) {}
      }
    });
    window.addEventListener('pageshow', function () { markMapViewed(); });
    window.addEventListener('focus', function () { markMapViewed(); });
    try {
      var m0 = getMap();
      if (m0) hookMapForShareView(m0);
    } catch (e0) {}
  }

  /** Stop GPS watch only (share toggle / shareWanted stay as-is). */
  function pauseShareGpsWatch() {
    if (presenceWatch != null) {
      try { navigator.geolocation.clearWatch(presenceWatch); } catch (e2) {}
      presenceWatch = null;
    }
  }

  /**
   * Live GPS for party share.
   * Foreground: high accuracy, frequent updates.
   * Background: keep running at low rate (~20s) so peers still see you after you leave the app.
   */
  function startShareGpsWatch(opts) {
    if (!navigator.geolocation) return;
    opts = opts || {};
    var bg = opts.background != null ? !!opts.background : isShareBackgrounded();
    pauseShareGpsWatch();
    presenceWatch = navigator.geolocation.watchPosition(function (pos) {
      if (!sharing) return;
      var lat = pos.coords.latitude, lng = pos.coords.longitude;
      // GPS course when moving; otherwise device compass
      var gpsH = pos.coords.heading;
      var speed = pos.coords.speed; // m/s
      var heading = null;
      if (gpsH != null && !isNaN(gpsH) && speed != null && speed > 0.8) {
        heading = gpsH; // course over ground while walking/driving
      } else {
        heading = resolveFacingHeading(gpsH);
      }
      pushPresence(lat, lng, heading, false);
    }, function (err) {
      console.warn('share location GPS error', err);
      // Only nag when the app is open
      if (isShareBackgrounded()) return;
      try {
        if (window.showAppCopyToast) {
          showAppCopyToast('<span class="act">Location error</span><br>Allow location access to share with party.');
        }
      } catch (e3) {}
    }, {
      enableHighAccuracy: !bg,
      maximumAge: bg ? 18000 : 4000,
      timeout: bg ? 25000 : 15000
    });
  }

  function resumeShareGpsWatchIfNeeded() {
    if (!sharing || !shareWanted) return;
    if (presenceWatch != null) return;
    startShareGpsWatch({ background: isShareBackgrounded() });
  }

  async function pushPresence(lat, lng, heading, force) {
    var vs = C.getViewState && C.getViewState();
    var sb = getSb();
    var user = getUser();
    if (!sharing || !vs || vs.mode !== 'shared' || !vs.sharedMapId || !sb || !user) return false;
    // Auto-pause after 1h without viewing the map (preference stays on)
    if (checkShareIdleTimeout()) return false;
    // Always resolve best facing heading (never wipe with null on heartbeat)
    var hdg = resolveFacingHeading(heading);
    if (hdg == null && lastSent.heading != null) hdg = lastSent.heading;

    var now = Date.now();
    var bg = isShareBackgrounded();
    var distM = 0;
    var moved = true;
    if (lastSent.lat != null) {
      distM = haversineM(lastSent.lat, lastSent.lng, lat, lng);
      moved = distM >= MOVE_M;
    }
    var headingTurned = lastSent.heading == null
      ? (hdg != null)
      : (hdg != null && headingDelta(lastSent.heading, hdg) >= HEADING_PUSH_DEG);
    // Delta-only: tiny wiggles / sub-threshold turns don't burn radio (except forced heartbeats)
    var meaningful = (lastSent.lat == null) ||
      distM >= DELTA_M ||
      (hdg != null && lastSent.heading != null && headingDelta(lastSent.heading, hdg) >= DELTA_HEADING_DEG) ||
      (hdg != null && lastSent.heading == null);

    if (!force && lastSent.at) {
      var elapsed = now - lastSent.at;
      var needMs = presenceCadenceMs(moved, bg);
      if (!meaningful) {
        // Same spot/heading: only send when heartbeat timer fires (keeps TTL / is_sharing fresh)
        if (elapsed < needMs) return true;
      } else if (bg) {
        if (elapsed < needMs) return true;
      } else {
        if (moved && elapsed < presenceCadenceMs(true, false)) return true;
        if (!moved && headingTurned && elapsed < HEADING_PUSH_MS * partySizeScale()) return true;
        if (!moved && !headingTurned && elapsed < needMs) return true;
      }
    }

    if (moved || lastSent.lat == null) lastRealMoveAt = now;

    var payload = {
      map_id: vs.sharedMapId,
      user_id: user.id,
      is_sharing: true,
      lat: lat,
      lng: lng,
      heading: hdg,
      started_at: new Date(shareStartedAt).toISOString(),
      last_moved_at: new Date(moved || !lastSent.at ? now : (lastRealMoveAt || now)).toISOString(),
      updated_at: new Date().toISOString()
    };
    try {
      var res = await sb.from('party_presence').upsert(payload, { onConflict: 'map_id,user_id' });
      if (res.error) {
        console.warn('presence push failed', res.error);
        try {
          if (!bg && window.showAppCopyToast) {
            showAppCopyToast('<span class="act">Share location failed</span><br>' +
              esc(res.error.message || 'Could not update party location'));
          }
        } catch (eT) {}
        return false;
      }
      lastSent = { lat: lat, lng: lng, heading: hdg, at: now };
      if (headingTurned) lastHeadingPushAt = now;
      return true;
    } catch (e) {
      console.warn('presence push', e);
      return false;
    }
  }

  function stopPresenceRealtime() {
    if (!presenceChannel) return;
    try {
      var sb = getSb() || window.__rsSb;
      if (sb && sb.removeChannel) sb.removeChannel(presenceChannel);
    } catch (e0) {
      try { presenceChannel.unsubscribe && presenceChannel.unsubscribe(); } catch (e1) {}
    }
    presenceChannel = null;
  }

  /**
   * Live peer dots: Realtime on party_presence so others appear within ~1s of sharing
   * without a manual refresh. Poll is backup if Realtime is unavailable.
   */
  function startPresenceRealtime(mapId) {
    stopPresenceRealtime();
    var sb = getSb() || window.__rsSb;
    if (!sb || !mapId || !sb.channel) return;
    try {
      presenceChannel = sb
        .channel('party-presence-' + String(mapId))
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'party_presence',
            filter: 'map_id=eq.' + mapId
          },
          function () {
            try {
              if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            } catch (eH) {}
            // Light pull (skip profile re-fetch) so dots update immediately both ways
            try { pullPresence({ skipMembers: true }); } catch (eP) {}
          }
        )
        .subscribe(function (/* status */) {});
    } catch (eCh) {
      console.warn('presence realtime unavailable', eCh);
      presenceChannel = null;
    }
  }

  function ensurePresenceRealtimeForCurrentMap() {
    var mid = currentSharedMapId();
    if (mid) startPresenceRealtime(mid);
    else stopPresenceRealtime();
  }

  function stopPartyHeadingWatch() {
    if (!headingWatchOn || !headingOrientHandler) return;
    try { window.removeEventListener('deviceorientationabsolute', headingOrientHandler, true); } catch (e0) {}
    try { window.removeEventListener('deviceorientation', headingOrientHandler, true); } catch (e1) {}
    headingWatchOn = false;
    headingOrientHandler = null;
  }

  function startPartyHeadingWatch() {
    if (headingWatchOn) return;
    headingOrientHandler = function (e) {
      if (!e) return;
      var raw = null;
      if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
        raw = e.webkitCompassHeading; // iOS: degrees from true/magnetic north
      } else if (typeof e.alpha === 'number' && !isNaN(e.alpha)) {
        raw = (360 - e.alpha) % 360;
      }
      raw = normalizeHeading(raw);
      if (raw == null) return;
      lastFacingHeading = raw;
      try { window.deviceHeadingDeg = raw; } catch (eW) {}
      // Heading-only network pushes only while the app is open (bg uses 20s pos+heading)
      if (sharing && lastSent.lat != null && !isShareBackgrounded()) {
        var now = Date.now();
        if (now - lastHeadingPushAt >= HEADING_PUSH_MS) {
          if (lastSent.heading == null || headingDelta(lastSent.heading, raw) >= HEADING_PUSH_DEG) {
            pushPresence(lastSent.lat, lastSent.lng, raw, false);
          }
        }
      }
    };
    try { window.addEventListener('deviceorientationabsolute', headingOrientHandler, true); } catch (eA) {}
    try { window.addEventListener('deviceorientation', headingOrientHandler, true); } catch (eR) {}
    headingWatchOn = true;
  }

  /** Heartbeat tick: peers when open; own pos+heading always (20s when backgrounded). */
  function shareHeartbeatTick() {
    if (!sharing) return;
    if (checkShareIdleTimeout()) return;
    var bg = isShareBackgrounded();
    // Pull party markers only while app is open (big data saver when backgrounded)
    if (!bg) {
      try { pullPresence(); } catch (eP) {}
    }
    if (bg) {
      // Fresh fix every ~20s while backgrounded (browsers throttle watchPosition heavily)
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(function (pos) {
        if (!sharing) return;
        var h = resolveFacingHeading(pos.coords.heading);
        pushPresence(pos.coords.latitude, pos.coords.longitude, h, true);
      }, function () {
        if (!sharing || lastSent.lat == null) return;
        var h2 = resolveFacingHeading(lastSent.heading);
        pushPresence(lastSent.lat, lastSent.lng, h2, true);
      }, {
        enableHighAccuracy: false,
        maximumAge: 18000,
        timeout: 20000
      });
    } else if (lastSent.lat != null) {
      var h3 = resolveFacingHeading(lastSent.heading);
      pushPresence(lastSent.lat, lastSent.lng, h3, true);
    }
  }

  function restartShareHeartbeat() {
    if (presenceTimer) {
      clearInterval(presenceTimer);
      presenceTimer = null;
    }
    if (!sharing) return;
    var ms = presenceCadenceMs(false, isShareBackgrounded());
    // Timer slightly denser than max cadence so stationary/move tiers can still fire on time
    ms = Math.max(2000, Math.min(ms, isShareBackgrounded() ? BG_HEARTBEAT_MS : HEARTBEAT_MS));
    presenceTimer = setInterval(shareHeartbeatTick, ms);
  }

  function requestOrientationPermissionIfNeeded() {
    return new Promise(function (resolve) {
      try {
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
          DeviceOrientationEvent.requestPermission()
            .then(function (state) { resolve(state === 'granted'); })
            .catch(function () { resolve(false); });
          return;
        }
      } catch (e) {
        resolve(false);
        return;
      }
      resolve(true);
    });
  }

  /** Called from main app compass updates (and our own orientation watch). */
  function onDeviceHeading(heading) {
    heading = normalizeHeading(heading);
    if (heading == null) return;
    lastFacingHeading = heading;
    // Only burn radio on heading-only while foregrounded
    if (sharing && lastSent.lat != null && !isShareBackgrounded()) {
      var now = Date.now();
      if (now - lastHeadingPushAt >= HEADING_PUSH_MS &&
          (lastSent.heading == null || headingDelta(lastSent.heading, heading) >= HEADING_PUSH_DEG)) {
        pushPresence(lastSent.lat, lastSent.lng, heading, false);
      }
    }
  }

  function startSharing(opts) {
    opts = opts || {};
    var silent = !!opts.silent;
    var resume = !!opts.resume;
    var vs = C.getViewState && C.getViewState();
    if (!vs || vs.mode !== 'shared' || !vs.sharedMapId) {
      if (!silent) {
        alert('Share location only works on a shared map. Open a shared map first (Settings → My Maps → View).');
      }
      return;
    }
    if (!navigator.geolocation) {
      if (!silent) alert('Geolocation not available on this device.');
      return;
    }
    if (!getSb() || !getUser()) {
      if (!silent) alert('Sign in required to share location with your party.');
      return;
    }
    // Already actively broadcasting
    if (sharing && resume) {
      markMapViewed({ skipResume: true });
      return;
    }
    // Ensure map reference for peers who pull while we share
    var m = getMap();
    if (m) {
      try { window.map = m; } catch (eM) {}
    }

    shareWanted = true;
    sharing = true;
    shareStartedAt = shareStartedAt || Date.now();
    if (!resume) shareStartedAt = Date.now();
    lastMapViewAt = Date.now();
    lastSent = { lat: null, lng: null, heading: null, at: 0 };
    lastHeadingPushAt = 0;
    persistSharePref();
    updateShareLocBtn();
    wireShareMapViewTracking();

    // iOS: compass permission must be requested from this user tap
    // (resume from background may skip permission prompt if already granted)
    requestOrientationPermissionIfNeeded().then(function (ok) {
      startPartyHeadingWatch();
      // Also ask main app compass stack if available
      try {
        if (typeof ensureDeviceOrientationPermission === 'function') {
          ensureDeviceOrientationPermission().then(function () {
            if (typeof startDeviceHeadingWatch === 'function') startDeviceHeadingWatch();
          });
        } else if (typeof startDeviceHeadingWatch === 'function') {
          startDeviceHeadingWatch();
        }
      } catch (eH) {}
      if (!ok && !silent) {
        try {
          if (window.showAppCopyToast) {
            showAppCopyToast('<span class="act">Compass optional</span><br>Location will still share; facing may use GPS course.');
          }
        } catch (eT) {}
      }
    });

    startShareGpsWatch({ background: isShareBackgrounded() });
    restartShareHeartbeat();
    // Realtime + immediate pull so party members see each other without manual refresh
    try { ensurePresenceRealtimeForCurrentMap(); } catch (eRt) {}
    try { pullPresence({ force: true }); } catch (ePull0) {}

    // Immediate force push
    navigator.geolocation.getCurrentPosition(function (pos) {
      var h0 = resolveFacingHeading(pos.coords.heading);
      pushPresence(pos.coords.latitude, pos.coords.longitude, h0, true).then(function (ok) {
        // Second pull shortly after first upsert so peers (and us) paint dots ASAP
        setTimeout(function () {
          try { pullPresence({ skipMembers: true, force: true }); } catch (eP2) {}
        }, 400);
        if (ok !== false && window.showAppCopyToast && !silent) {
          showAppCopyToast(
            '<span class="act">Sharing location</span><br>' +
            'Party can see you live. Background ~20s pings; auto-pause after 1 hour away.'
          );
        } else if (ok !== false && window.showAppCopyToast && resume) {
          showAppCopyToast('<span class="act">Sharing location</span><br>Resumed — 1 hour timer restarted.');
        }
      });
    }, function (err) {
      console.warn(err);
      if (!silent) {
        alert('Could not get your location. Check location permission and try again.');
        stopSharing('user');
      } else {
        // Resume failed (permission) — keep toggle wanted for next open
        sharing = false;
        updateShareLocBtn();
        persistSharePref();
      }
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
  }

  /**
   * Stop live GPS broadcast.
   * reason:
   *  - 'idle' / 'auto': pause after 1h without map view — keep toggle ON in background
   *  - 'user' / other: full off — clear preference
   */
  async function stopSharing(reason) {
    var wasSharing = sharing;
    sharing = false;
    if (presenceWatch != null) {
      try { navigator.geolocation.clearWatch(presenceWatch); } catch (e2) {}
      presenceWatch = null;
    }
    if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
    stopPartyHeadingWatch();
    // Keep presence realtime while on a shared map so we still SEE others after we stop sharing
    try { ensurePresenceRealtimeForCurrentMap(); } catch (eRt2) {}

    var idlePause = (reason === 'idle' || reason === 'auto');
    if (idlePause) {
      // Keep shareWanted + pref so toolbar stays on and we can auto-resume
      shareWanted = true;
      persistSharePref();
    } else {
      clearSharePref();
    }
    updateShareLocBtn();

    var vs = C.getViewState && C.getViewState();
    var sb = getSb();
    var user = getUser();
    if (sb && user && vs && vs.sharedMapId) {
      try {
        var res = await sb.from('party_presence').upsert({
          map_id: vs.sharedMapId,
          user_id: user.id,
          is_sharing: false,
          updated_at: new Date().toISOString()
        }, { onConflict: 'map_id,user_id' });
        if (res.error) console.warn('stop share presence', res.error);
      } catch (e3) {}
    }
    if (idlePause) {
      try {
        showAppCopyToast && showAppCopyToast(
          '<span class="act">Location sharing paused</span><br>' +
          'Auto-off after 1 hour in the background. Toggle stays on — opens again when you return to the app.'
        );
      } catch (e4) {}
    } else if (wasSharing || reason === 'user') {
      try {
        showAppCopyToast && showAppCopyToast('<span class="act">Stopped sharing location</span>');
      } catch (e5) {}
    }
  }

  function toggleSharing() {
    // If toggle is on (active or idle-paused), user tap turns preference fully off
    if (shareWanted || sharing) stopSharing('user');
    else startSharing();
  }

  function updateShareLocBtn() {
    var btn = $('share-loc-btn');
    if (!btn) return;
    // Button stays toggled when user wants sharing (even if idle-paused)
    var on = !!(shareWanted || sharing);
    btn.classList.remove('is-sharing');
    if (on && sharing) {
      // force reflow so animation restarts
      void btn.offsetWidth;
      btn.classList.add('is-sharing');
    } else if (on && !sharing) {
      // Wanted but paused: pressed look without strong pulse
      btn.classList.add('is-sharing');
      btn.classList.add('is-share-paused');
    } else {
      btn.classList.remove('is-share-paused');
    }
    if (sharing) btn.classList.remove('is-share-paused');
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (sharing) {
      btn.title = 'Sharing location with party (tap to stop)';
      btn.setAttribute('data-mbb-tip', 'Sharing location');
    } else if (shareWanted) {
      btn.title = 'Share on (paused after 1h in background) — open app to resume, or tap to turn off';
      btn.setAttribute('data-mbb-tip', 'Share paused — open app');
    } else {
      btn.title = 'Share current location with party';
      btn.setAttribute('data-mbb-tip', 'Share location');
    }
  }

  // ---- List maps / UI ----
  async function listPrivateMaps() {
    var sb = window.__rsSb;
    if (!sb) return [];
    var { data, error } = await sb.rpc('list_my_private_maps');
    if (error) throw error;
    return data || [];
  }

  async function listMembers() {
    var vs = C.getViewState && C.getViewState();
    var sb = getSb() || window.__rsSb;
    if (!vs || vs.mode !== 'shared' || !vs.sharedMapId || !sb) {
      window.__rsPartyMembers = [];
      return [];
    }
    var { data, error } = await sb.rpc('list_shared_map_members', { p_map_id: vs.sharedMapId });
    if (error) throw error;
    var members = data || [];
    // Always merge profile direction_icon_id / arrow_color so others see each user's default
    await enrichMembersWithProfiles(members);
    await loadPartyPrefs(vs.sharedMapId);
    window.__rsPartyMembers = members;
    return window.__rsPartyMembers;
  }

  /**
   * Wire action buttons into a modal actions container.
   * Handlers run before close so form fields still exist.
   */
  function wireSimpleModalActions(wrap, act, buttons) {
    if (!act) return;
    act.innerHTML = '';
    (buttons || []).forEach(function (b) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'settings-subbtn' + (b.primary ? ' rs-btn-primary' : '');
      btn.textContent = b.label;
      btn.onclick = function () {
        var err = null;
        if (b.onClick) {
          try {
            var ret = b.onClick();
            if (ret && typeof ret.then === 'function') {
              ret.then(function () {
                if (b.close !== false && wrap && wrap.parentNode) wrap.remove();
              }).catch(function (e) {
                err = e;
                alert((e && e.message) || String(e));
              });
              return;
            }
          } catch (eClick) {
            err = eClick;
            alert((eClick && eClick.message) || String(eClick));
            return;
          }
        }
        if (!err && b.close !== false && wrap && wrap.parentNode) wrap.remove();
      };
      act.appendChild(btn);
    });
  }

  /**
   * Update an existing simple modal in place (same position — no stack, no recreate).
   */
  function updateSimpleModal(wrap, title, bodyHtml, buttons, opts) {
    opts = opts || {};
    if (!wrap) return null;
    wrap.classList.add('active');
    wrap.classList.remove('rs-simple-modal-stack');
    wrap.setAttribute('data-rs-stack', '0');
    var card = wrap.querySelector('.rs-simple-card');
    if (!card) {
      card = document.createElement('div');
      card.className = 'rs-simple-card';
      wrap.appendChild(card);
    }
    card.className = 'rs-simple-card' +
      (opts.compact ? ' rs-compact-edit' : '') +
      (opts.cardClass ? (' ' + opts.cardClass) : '');
    card.onclick = function (e) { e.stopPropagation(); };
    var h3 = card.querySelector('h3');
    var body = card.querySelector('.rs-simple-body');
    var act = card.querySelector('.rs-simple-actions');
    if (!h3 || !body || !act) {
      card.innerHTML = '<h3></h3><div class="rs-simple-body"></div><div class="rs-simple-actions"></div>';
      h3 = card.querySelector('h3');
      body = card.querySelector('.rs-simple-body');
      act = card.querySelector('.rs-simple-actions');
    }
    if (h3) h3.textContent = title || '';
    if (body) body.innerHTML = bodyHtml || '';
    wireSimpleModalActions(wrap, act, buttons);
    return wrap;
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.stack] — deprecated for share flow; prefer reuse in place
   * @param {boolean} [opts.reuse] — update existing #rs-simple-modal content (default true)
   * @param {string} [opts.id] — element id (default rs-simple-modal)
   * @param {string} [opts.cardClass] — extra class on card
   */
  function showSimpleModal(title, bodyHtml, buttons, opts) {
    opts = opts || {};
    var reuse = opts.reuse !== false && !opts.stack;
    var modalId = opts.id || 'rs-simple-modal';

    // Clear leftover stacked layers — we no longer stack share steps
    try {
      document.querySelectorAll('.rs-simple-modal.rs-simple-modal-stack').forEach(function (el) {
        try { el.remove(); } catch (eR) {}
      });
    } catch (e0) {}

    if (reuse) {
      var existing = $(modalId) || document.getElementById('rs-simple-modal');
      if (existing) {
        return updateSimpleModal(existing, title, bodyHtml, buttons, opts);
      }
    } else if (!opts.stack) {
      try {
        var old = $(modalId);
        if (old) old.remove();
      } catch (e1) {}
    }

    var wrap = document.createElement('div');
    wrap.id = modalId;
    wrap.className = 'rs-simple-modal active';
    wrap.setAttribute('data-rs-stack', '0');
    wrap.onclick = function (e) {
      if (e.target === wrap) wrap.remove();
    };
    var card = document.createElement('div');
    card.className = 'rs-simple-card' +
      (opts.compact ? ' rs-compact-edit' : '') +
      (opts.cardClass ? (' ' + opts.cardClass) : '');
    card.onclick = function (e) { e.stopPropagation(); };
    card.innerHTML = '<h3>' + esc(title) + '</h3><div class="rs-simple-body">' + bodyHtml +
      '</div><div class="rs-simple-actions"></div>';
    wrap.appendChild(card);
    document.body.appendChild(wrap);
    wireSimpleModalActions(wrap, card.querySelector('.rs-simple-actions'), buttons);
    return wrap;
  }

  function closeSimpleModal() {
    try {
      document.querySelectorAll('.rs-simple-modal').forEach(function (m) {
        try { m.remove(); } catch (e) {}
      });
    } catch (e2) {}
  }

  async function openSharedMapActions(mapRow) {
    showSimpleModal(mapRow.name || 'Shared map',
      '<p class="settings-hint">Code: <strong>' + esc(mapRow.code) + '</strong></p>',
      [
        {
          label: 'View this map',
          primary: true,
          onClick: function () {
            C.switchToShared(mapRow.id).then(function () {
              refreshMapsUi();
              pullPresence();
            }).catch(function (e) { alert(e.message || e); });
          }
        },
        {
          label: 'Share this map',
          onClick: function () {
            var text = shareMapInviteText(mapRow);
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text).then(function () {
                alert('Copied:\n' + text);
              }).catch(function () { window.prompt('Copy:', text); });
            } else window.prompt('Copy:', text);
          }
        },
        { label: 'Cancel' }
      ]
    );
  }

  async function openPrivateMapActions(mapRow) {
    showSimpleModal(mapRow.name || 'Private map',
      '<p class="settings-hint">Private — only you. Rename or open.</p>',
      [
        {
          label: 'View this map',
          primary: true,
          onClick: function () {
            switchToPrivate(mapRow.id).catch(function (e) { alert(e.message || e); });
          }
        },
        {
          label: 'Rename map',
          onClick: function () {
            var n = prompt('New name:', mapRow.name || '');
            if (!n || !n.trim()) return;
            renamePrivate(mapRow.id, n.trim()).then(refreshMapsUi).catch(function (e) { alert(e.message || e); });
          }
        },
        { label: 'Cancel' }
      ]
    );
  }

  async function switchToPrivate(mapId) {
    var sb = window.__rsSb;
    if (!sb) throw new Error('Not ready');
    // save current
    if (C.forcePush) C.forcePush();
    await new Promise(function (r) { setTimeout(r, 100); });
    if (C.markDirty) { /* snapshot via collect happens in push */ }

    // Use original snapshot/cache path via internal hooks we expose
    if (typeof C._switchToPrivate === 'function') {
      await C._switchToPrivate(mapId);
      try { recordMapVisit('private', mapId); } catch (eV) {}
      // Always refresh chrome labels after switch (mobile title + max-mode chip)
      try { updateBrandName(); } catch (eBn) {}
      try { refreshMapsUi(); } catch (eRu) {}
      // Leave shared map → no party presence traffic
      try { stopPresenceRealtime(); } catch (eRt) {}
      try { clearPartyMarkers(); } catch (eCl) {}
      return;
    }
    // Fallback: set view + pull
    var { data, error } = await sb.from('private_maps').select('id, name, map_state, map_revision').eq('id', mapId).maybeSingle();
    if (error || !data) throw error || new Error('Map not found');
    var vs = C.getViewState();
    vs.mode = 'private';
    vs.privateMapId = data.id;
    vs.privateMapName = data.name;
    vs.sharedMapId = null;
    vs.sharedMapName = '';
    vs.sharedMapCode = '';
    // personal alias
    if (vs.mode === 'private') { /* ok */ }
    try {
      localStorage.setItem('reg_slayer_view_v1', JSON.stringify(vs));
    } catch (e) {}
    // apply state
    if (window.applyMapStateFromCloud) {
      window.applyMapStateFromCloud(data.map_state || {});
    } else if (typeof C._applyRemoteState === 'function') {
      C._applyRemoteState(data.map_state, data.map_revision);
    }
    // Write local keys via refresh helper
    try {
      var st = data.map_state || {};
      localStorage.setItem('alabama_hunt_custom_pins', JSON.stringify(st.pins || []));
      localStorage.setItem('alabama_hunt_historical_hunts', JSON.stringify(st.hunts || []));
      localStorage.setItem('alabama_hunt_custom_areas_v1', JSON.stringify(st.customAreas || []));
      localStorage.setItem('alabama_hunt_measured_paths_v1', JSON.stringify(st.measuredPaths || []));
      localStorage.setItem('alabama_hunt_user_stands_v1', JSON.stringify(st.stands || {}));
      localStorage.setItem('alabama_hunt_hidden_locations_v1', JSON.stringify(st.hiddenLocs || []));
      if (window.regSlayerRefreshMapData) window.regSlayerRefreshMapData();
    } catch (e2) {}
    clearPartyMarkers();
    stopSharing();
    updateBrandName();
    refreshMapsUi();
    if (C.persistViewPrefsCloud) { /* optional */ }
  }

  async function renamePrivate(id, name) {
    var sb = window.__rsSb;
    var { data, error } = await sb.rpc('rename_private_map', { p_id: id, p_name: name });
    if (error) throw error;
    var vs = C.getViewState();
    if (vs && vs.privateMapId === id) {
      vs.privateMapName = data.name;
      try { localStorage.setItem('reg_slayer_view_v1', JSON.stringify(vs)); } catch (e) {}
      updateBrandName();
    }
    return data;
  }

  async function createPrivateMap(name) {
    var sb = window.__rsSb;
    // Save current map before creating (switchToPrivate also snapshots; force upload first)
    try {
      if (C.forcePush) C.forcePush();
      await new Promise(function (r) { setTimeout(r, 150); });
    } catch (eSave) {}
    var { data, error } = await sb.rpc('create_private_map', { p_name: name });
    if (error) throw error;
    // switchToPrivate → applyLiveKeysFromCurrentSlot clears previous pins for empty new maps
    await switchToPrivate(data.id);
    return data;
  }

  function currentMapDisplayName(vs) {
    vs = vs || (C.getViewState && C.getViewState());
    if (!vs) return 'My Map';
    if (vs.mode === 'shared') {
      return displayMapName('shared', vs.sharedMapId, vs.sharedMapName || 'Shared map');
    }
    return displayMapName('private', vs.privateMapId, vs.privateMapName || 'My Map');
  }

  /**
   * Keep viewState map names aligned with the live private/shared list
   * so the mobile title / max-mode chip never stay stuck on a stale "My Map".
   */
  function syncViewStateNamesFromLists(pmaps, smaps) {
    var vs = C.getViewState && C.getViewState();
    if (!vs) return false;
    var changed = false;
    try {
      if (vs.mode === 'shared' && vs.sharedMapId) {
        var sm = (smaps || []).find(function (m) { return String(m.id) === String(vs.sharedMapId); });
        if (sm) {
          if (sm.name && String(sm.name) !== String(vs.sharedMapName || '')) {
            vs.sharedMapName = sm.name;
            changed = true;
          }
          if (sm.code && String(sm.code) !== String(vs.sharedMapCode || '')) {
            vs.sharedMapCode = sm.code;
            changed = true;
          }
        }
      } else if (vs.privateMapId) {
        var pm = (pmaps || []).find(function (m) { return String(m.id) === String(vs.privateMapId); });
        if (pm && pm.name && String(pm.name) !== String(vs.privateMapName || '')) {
          vs.privateMapName = pm.name;
          changed = true;
        }
      }
      if (changed) {
        try { localStorage.setItem('reg_slayer_view_v1', JSON.stringify(vs)); } catch (eLs) {}
      }
    } catch (eSync) {}
    return changed;
  }

  /** All chrome that shows the active map name (mobile title, max chip, brand, FS). */
  function updateBrandName() {
    var vs = C.getViewState && C.getViewState();
    var label = currentMapDisplayName(vs);
    if (!label || !String(label).trim()) label = 'My Map';
    var title = (vs && vs.mode === 'shared')
      ? ('Shared map · ' + ((vs && vs.sharedMapCode) || '') + ' — click to switch maps')
      : 'Private map — click to switch maps';
    ['brand-map-name', 'map-title-mobile', 'map-fs-title', 'map-bottom-map-name'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      // Always overwrite — never leave the static HTML "My Map" placeholder
      el.textContent = label;
      el.title = title + ' · ' + label;
      try { el.setAttribute('aria-label', 'Map: ' + label + '. Click to switch.'); } catch (eA) {}
    });
    // Settings status line
    try {
      var modeLabel = $('set-map-mode-label');
      if (modeLabel && vs) {
        if (vs.mode === 'shared') {
          modeLabel.textContent = 'Viewing: ' + label + ' (shared)';
        } else {
          modeLabel.textContent = 'Viewing: ' + label + ' (not shared)';
        }
      }
    } catch (eMl) {}
  }

  /** Cached map lists so the switcher opens instantly (no laggy blank wait). */
  var _mapSwitcherCache = { pmaps: null, smaps: null, at: 0 };
  var MAP_SWITCHER_CACHE_MS = 45000;

  function closeMapSwitcher() {
    var dd = $('map-switcher-dropdown');
    if (dd) {
      dd.classList.remove('open');
      /* Let CSS transition finish before clearing list / open-up class */
      clearTimeout(dd._rsCloseT);
      dd._rsCloseT = setTimeout(function () {
        if (!dd.classList.contains('open')) {
          dd.classList.remove('open-up');
          dd.style.top = '';
          dd.style.bottom = '';
          /* Keep last HTML so next open can paint immediately if cache hits */
        }
      }, 200);
    }
    document.querySelectorAll('#map-title-mobile, #map-fs-title, #brand-map-name, #map-bottom-map-name').forEach(function (b) {
      try { b.setAttribute('aria-expanded', 'false'); } catch (e) {}
    });
    document.removeEventListener('click', _mapSwitcherOutside, true);
  }
  function _mapSwitcherOutside(ev) {
    var dd = $('map-switcher-dropdown');
    if (!dd || !dd.classList.contains('open')) return;
    if (dd.contains(ev.target)) return;
    if (ev.target && ev.target.closest && (
      ev.target.closest('#map-title-mobile') ||
      ev.target.closest('#map-fs-title') ||
      ev.target.closest('#brand-map-name') ||
      ev.target.closest('#map-bottom-map-name')
    )) return;
    closeMapSwitcher();
  }

  /** Position map-switcher under or above the anchor. Bottom chip opens upward so the list scrolls up. */
  function placeMapSwitcherDropdown(dd, anchorEl) {
    if (!dd || !anchorEl) return;
    try {
      var r = anchorEl.getBoundingClientRect();
      var w = Math.max(200, Math.min(300, Math.max(r.width + 48, 220)));
      dd.style.minWidth = w + 'px';
      dd.style.width = 'auto';
      dd.style.maxWidth = Math.min(320, window.innerWidth - 16) + 'px';

      var openUp = anchorEl.id === 'map-bottom-map-name' ||
        (r.top > window.innerHeight * 0.55);

      var left = r.left + (r.width / 2) - (w / 2);
      if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
      if (left < 8) left = 8;
      dd.style.left = Math.round(left) + 'px';

      if (openUp) {
        dd.classList.add('open-up');
        var gap = 6;
        var room = Math.max(100, r.top - 12);
        var maxH = Math.min(360, room);
        dd.style.maxHeight = Math.round(maxH) + 'px';
        dd.style.top = 'auto';
        dd.style.bottom = Math.round(window.innerHeight - r.top + gap) + 'px';
      } else {
        dd.classList.remove('open-up');
        var top = r.bottom + 4;
        var maxDown = Math.min(360, window.innerHeight - top - 8);
        dd.style.maxHeight = Math.round(Math.max(120, maxDown)) + 'px';
        dd.style.bottom = 'auto';
        dd.style.top = Math.round(top) + 'px';
      }
    } catch (ePos) {
      dd.style.left = '12px';
      dd.style.top = '60px';
      dd.style.bottom = 'auto';
    }
  }

  function isMapSwitcherCurrent(vs, kind, id) {
    if (!vs) return false;
    if (kind === 'shared') return vs.mode === 'shared' && String(vs.sharedMapId) === String(id);
    return (vs.mode === 'private' || vs.mode === 'personal') && String(vs.privateMapId) === String(id);
  }

  function buildMapSwitcherHtml(pmaps, smaps, vs) {
    var html = '';
    function row(kind, m, name, cur, showShare) {
      var line = '<div class="msd-row">' +
        '<button type="button" class="msd-item' + (cur ? ' is-current' : '') +
        '" data-kind="' + esc(kind) + '" data-id="' + esc(m.id) + '" role="option" aria-selected="' +
        (cur ? 'true' : 'false') + '">' + esc(name) + (cur ? ' · viewing' : '') + '</button>';
      if (showShare) {
        line += '<button type="button" class="msd-share" data-kind="' + esc(kind) +
          '" data-id="' + esc(m.id) + '" data-name="' + esc(name) +
          (m.code != null ? '" data-code="' + esc(String(m.code)) : '') +
          '" title="Copy map invite">Share</button>';
      }
      line += '</div>';
      return line;
    }
    html += '<div class="msd-group">Not shared</div>';
    if (!pmaps || !pmaps.length) {
      html += '<div class="msd-empty">No private maps</div>';
    } else {
      pmaps.forEach(function (m) {
        var name = displayMapName('private', m.id, m.name || 'Private map');
        var cur = isMapSwitcherCurrent(vs, 'private', m.id);
        // User-created private maps: Share (same as Settings → creates shared invite)
        html += row('private', m, name, cur, true);
      });
    }
    html += '<div class="msd-group">Shared</div>';
    if (!smaps || !smaps.length) {
      html += '<div class="msd-empty">No shared maps</div>';
    } else {
      smaps.forEach(function (m) {
        var name = displayMapName('shared', m.id, m.name || 'Shared map');
        var cur = isMapSwitcherCurrent(vs, 'shared', m.id);
        // Share only for maps this user created/hosts (invite code)
        var canShare = m.is_host !== false && (m.is_host === true || m.code != null);
        html += row('shared', m, name, cur, !!canShare);
      });
    }
    return html;
  }

  function findMapRowInCache(kind, id) {
    var lists = _mapSwitcherCache || {};
    var arr = kind === 'shared' ? lists.smaps : lists.pmaps;
    if (!arr) return null;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && String(arr[i].id) === String(id)) return arr[i];
    }
    return null;
  }

  function wireMapSwitcherItems(dd, vs) {
    if (!dd) return;
    dd.querySelectorAll('.msd-item').forEach(function (btn) {
      btn.onclick = function (ev) {
        if (ev) { ev.preventDefault(); ev.stopPropagation(); }
        var kind = btn.getAttribute('data-kind');
        var id = btn.getAttribute('data-id');
        closeMapSwitcher();
        if (isMapSwitcherCurrent(vs, kind, id)) return;
        mapsUiSelected = { kind: kind, id: id };
        if (kind === 'private') {
          switchToPrivate(id).then(function () {
            updateBrandName();
            refreshMapsUi();
          }).catch(function (e) { alert(e.message || e); });
        } else if (C.switchToShared) {
          C.switchToShared(id).then(function () {
            updateBrandName();
            refreshMapsUi();
            try { ensurePresenceRealtimeForCurrentMap(); } catch (eRt) {}
            try { restartPartyPullLoop(); } catch (ePl) {}
            try { pullPresence({ force: true }); } catch (eP) {}
          }).catch(function (e) { alert(e.message || e); });
        }
      };
    });
    dd.querySelectorAll('.msd-share').forEach(function (btn) {
      btn.onclick = function (ev) {
        if (ev) { ev.preventDefault(); ev.stopPropagation(); }
        var kind = btn.getAttribute('data-kind');
        var id = btn.getAttribute('data-id');
        var name = btn.getAttribute('data-name') || 'Map';
        var code = btn.getAttribute('data-code') || '';
        var row = findMapRowInCache(kind, id) || {
          id: id,
          name: name,
          code: code || undefined,
          is_host: true
        };
        // Same invite path as Settings → Share
        if (kind === 'shared') {
          copyMapInvite(row);
        } else {
          sharePrivateMapAsInvite(id, name);
        }
      };
    });
  }

  async function fetchMapSwitcherLists() {
    var pmaps = [];
    var smaps = [];
    try { pmaps = await listPrivateMaps(); } catch (eP) { pmaps = []; }
    try {
      if (C.listMySharedMaps) smaps = await C.listMySharedMaps();
      else {
        var sb0 = getSb() || window.__rsSb;
        if (sb0) {
          var r0 = await sb0.rpc('list_my_shared_maps');
          smaps = r0.data || [];
        }
      }
    } catch (eS) { smaps = []; }
    _mapSwitcherCache = { pmaps: pmaps || [], smaps: smaps || [], at: Date.now() };
    return _mapSwitcherCache;
  }

  /** Warm the map list so the first name-click is instant */
  function prefetchMapSwitcherLists() {
    try {
      if (_mapSwitcherCache.at && (Date.now() - _mapSwitcherCache.at) < MAP_SWITCHER_CACHE_MS) return;
      fetchMapSwitcherLists().catch(function () {});
    } catch (e) {}
  }

  async function openMapSwitcher(anchorEl) {
    var dd = $('map-switcher-dropdown');
    if (!dd) {
      dd = document.createElement('div');
      dd.id = 'map-switcher-dropdown';
      dd.setAttribute('role', 'listbox');
      dd.setAttribute('aria-label', 'Your maps');
      document.body.appendChild(dd);
    }
    clearTimeout(dd._rsCloseT);
    // Toggle closed if already open from same anchor
    if (dd.classList.contains('open') && dd._rsAnchor === anchorEl) {
      closeMapSwitcher();
      return;
    }
    dd._rsAnchor = anchorEl || null;
    var vs = C.getViewState && C.getViewState();
    var cacheFresh = _mapSwitcherCache.at &&
      (Date.now() - _mapSwitcherCache.at) < MAP_SWITCHER_CACHE_MS &&
      (_mapSwitcherCache.pmaps || _mapSwitcherCache.smaps);

    /* Paint + place + open immediately (no double-rAF / no blank flash) */
    if (cacheFresh) {
      var html0 = buildMapSwitcherHtml(_mapSwitcherCache.pmaps, _mapSwitcherCache.smaps, vs);
      if (dd._rsHtml !== html0) {
        dd.innerHTML = html0;
        dd._rsHtml = html0;
        wireMapSwitcherItems(dd, vs);
      }
    } else if (!dd.querySelector('.msd-item') && !dd.querySelector('.msd-row')) {
      dd.innerHTML = '<div class="msd-empty">Loading maps…</div>';
      dd._rsHtml = '';
    }

    if (anchorEl) {
      try { anchorEl.setAttribute('aria-expanded', 'true'); } catch (e) {}
      placeMapSwitcherDropdown(dd, anchorEl);
    }
    // Open on same frame as place — smoother than delayed class toggles
    dd.classList.add('open');
    setTimeout(function () {
      document.addEventListener('click', _mapSwitcherOutside, true);
    }, 0);

    var gen = (dd._rsFetchGen = (dd._rsFetchGen || 0) + 1);
    try {
      var lists = await fetchMapSwitcherLists();
      if (gen !== dd._rsFetchGen || !dd.classList.contains('open')) return;
      try { syncViewStateNamesFromLists(lists.pmaps, lists.smaps); } catch (eSn2) {}
      try { updateBrandName(); } catch (eBn2) {}
      vs = C.getViewState && C.getViewState();
      var html1 = buildMapSwitcherHtml(lists.pmaps, lists.smaps, vs);
      // Only repaint if list changed — avoids flicker mid-open
      if (html1 !== dd._rsHtml) {
        dd.innerHTML = html1;
        dd._rsHtml = html1;
        wireMapSwitcherItems(dd, vs);
        if (anchorEl) placeMapSwitcherDropdown(dd, anchorEl);
      }
    } catch (eFetch) {
      if (!dd.querySelector('.msd-item') && !dd.querySelector('.msd-row')) {
        dd.innerHTML = '<div class="msd-empty">Could not load maps</div>';
        dd._rsHtml = '';
      }
    }
  }
  window.openMapSwitcher = openMapSwitcher;
  window.closeMapSwitcher = closeMapSwitcher;
  window.prefetchMapSwitcherLists = prefetchMapSwitcherLists;

  function shareMapInviteText(mapRow) {
    var code = mapRow && mapRow.code != null ? String(mapRow.code).replace(/\D/g, '').slice(0, 6) : '';
    var name = displayMapName(
      'shared',
      mapRow && mapRow.id,
      (mapRow && mapRow.name) || 'Hunt map'
    );
    if (window.RegSlayerCloud && typeof window.RegSlayerCloud.inviteShareText === 'function') {
      return window.RegSlayerCloud.inviteShareText(code, name);
    }
    var link = (window.RegSlayerCloud && typeof window.RegSlayerCloud.inviteJoinUrl === 'function')
      ? window.RegSlayerCloud.inviteJoinUrl(code)
      : (((window.location && window.location.origin) || 'https://regslayer.com') + '/?join=' + code);
    return 'Join my map!\nMap: ' + name + '\nCode: ' + code + '\n' + link;
  }

  /** Clipboard that works on mobile Safari inside Settings (not only HTTPS clipboard API). */
  function copyTextRobust(text) {
    return new Promise(function (resolve, reject) {
      function fallback() {
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.setAttribute('aria-hidden', 'true');
          ta.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;padding:0;border:0;';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          ta.setSelectionRange(0, text.length);
          var ok = document.execCommand('copy');
          document.body.removeChild(ta);
          if (ok) resolve(true);
          else reject(new Error('execCommand copy failed'));
        } catch (e) {
          reject(e);
        }
      }
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' &&
            (window.isSecureContext !== false)) {
          navigator.clipboard.writeText(text).then(function () {
            resolve(true);
          }).catch(function () {
            fallback();
          });
          return;
        }
      } catch (eClip) {}
      fallback();
    });
  }

  /**
   * Copy join invite (map name + 6-digit code + link) and show a Settings-visible modal.
   * (Toast under the map is hidden behind #settings-modal — users thought Share did nothing.)
   */
  function copyMapInvite(mapRow) {
    if (!mapRow) {
      alert('Could not find this map.');
      return;
    }
    var code = mapRow.code != null ? String(mapRow.code).replace(/\D/g, '').slice(0, 6) : '';
    var name = displayMapName('shared', mapRow.id, mapRow.name || 'Hunt map');

    function showInviteUi(copied) {
      var text = shareMapInviteText(mapRow);
      var body =
        '<p class="settings-status" style="margin:0 0 8px;">' +
          (copied
            ? '<strong style="color:var(--accent);">Invite copied to clipboard.</strong>'
            : '<strong style="color:#f87171;">Could not auto-copy</strong> — select the text below or use Copy again.') +
        '</p>' +
        '<p style="margin:0 0 6px;font-size:14px;font-weight:800;color:#fff;">Code: ' +
          '<span style="color:var(--accent);letter-spacing:0.12em;">' + esc(code || '———') + '</span></p>' +
        '<p class="settings-status" style="margin:0 0 4px;">Map: <strong>' + esc(name) + '</strong></p>' +
        '<pre style="margin:8px 0 0;padding:10px;border-radius:8px;border:1px solid var(--border);' +
          'background:rgba(0,0,0,0.35);font-size:11px;line-height:1.4;white-space:pre-wrap;word-break:break-word;' +
          'color:#e8efe4;user-select:all;-webkit-user-select:all;">' + esc(text) + '</pre>';
      showSimpleModal(copied ? 'Invite ready' : 'Share map invite', body, [
        {
          label: copied ? 'Done' : 'Copy again',
          primary: true,
          onClick: function () {
            if (copied) return;
            return copyTextRobust(text).then(function () {
              try {
                if (window.showAppCopyToast) {
                  showAppCopyToast('<span class="act">Invite copied</span><br>Code ' + esc(code));
                }
              } catch (eT) {}
              showInviteUi(true);
            }).catch(function () {
              window.prompt('Copy this invite:', text);
            });
          }
        },
        { label: 'Close' }
      ]);
      try {
        if (copied && window.showAppCopyToast) {
          showAppCopyToast('<span class="act">Invite copied</span><br>Code ' + esc(code));
        }
      } catch (eToast) {}
    }

    if (!code) {
      // Fetch code if list row was incomplete
      var sb = getSb() || window.__rsSb;
      if (sb && mapRow.id) {
        sb.from('shared_maps').select('id, name, code').eq('id', mapRow.id).maybeSingle()
          .then(function (res) {
            if (res && res.data && res.data.code) {
              mapRow = Object.assign({}, mapRow, res.data);
              code = String(res.data.code).replace(/\D/g, '').slice(0, 6);
              var text2 = shareMapInviteText(mapRow);
              return copyTextRobust(text2).then(function () { showInviteUi(true); })
                .catch(function () { showInviteUi(false); });
            }
            alert('No invite code for this map. You may need to be the host of a shared map.');
          })
          .catch(function () {
            alert('Could not load invite code. Check your connection and try again.');
          });
        return;
      }
      alert('No invite code for this map.');
      return;
    }

    var text = shareMapInviteText(mapRow);
    copyTextRobust(text).then(function () {
      showInviteUi(true);
    }).catch(function () {
      showInviteUi(false);
    });
  }

  /** Private map has no code — create a shared map from current data and copy invite. */
  function sharePrivateMapAsInvite(privateId, privateName) {
    if (!C.createSharedMap) {
      showSimpleModal('Share map',
        '<p class="settings-status">Sign in to create a shared map and get a 6-digit join code.</p>',
        [{ label: 'OK', primary: true }]
      );
      return;
    }
    var name = (privateName && String(privateName).trim()) || 'Hunt map';
    showSimpleModal('Share map',
      '<p class="settings-status">Private maps do not have a join code. Create a <strong>shared</strong> copy named <strong>' +
        esc(name) + '</strong> and copy the invite (map name + 6-digit code) for partners?</p>',
      [
        {
          label: 'Create shared & copy invite',
          primary: true,
          onClick: function () {
            return switchToPrivate(privateId).then(function () {
              return C.createSharedMap(name);
            }).then(function (m) {
              if (!m) throw new Error('Could not create shared map');
              copyMapInvite(m);
              try { refreshMapsUi(); } catch (eR) {}
            }).catch(function (e) {
              alert((e && e.message) || String(e));
            });
          }
        },
        { label: 'Cancel' }
      ]
    );
  }

  function loadMapAliases() {
    try {
      return JSON.parse(localStorage.getItem(MAP_ALIAS_KEY) || '{}') || {};
    } catch (e) { return {}; }
  }
  function saveMapAlias(kind, id, name) {
    var o = loadMapAliases();
    var key = kind + ':' + id;
    if (name && String(name).trim()) o[key] = String(name).trim().slice(0, 60);
    else delete o[key];
    try { localStorage.setItem(MAP_ALIAS_KEY, JSON.stringify(o)); } catch (e) {}
  }
  function getMapAlias(kind, id) {
    var o = loadMapAliases();
    return o[kind + ':' + id] || null;
  }
  function displayMapName(kind, id, serverName) {
    return getMapAlias(kind, id) || serverName || (kind === 'shared' ? 'Shared map' : 'Private map');
  }

  async function listMySharedForRename(mapId) {
    var smaps = [];
    try {
      if (C.listMySharedMaps) smaps = await C.listMySharedMaps();
      if (!smaps || !smaps.length) {
        var sb0 = getSb() || window.__rsSb;
        if (sb0) {
          var r0 = await sb0.rpc('list_my_shared_maps');
          smaps = r0.data || [];
        }
      }
    } catch (e) { smaps = []; }
    var m = (smaps || []).find(function (x) { return String(x.id) === String(mapId); });
    if (!m) return null;
    return {
      kind: 'shared',
      id: m.id,
      name: m.name || 'Shared map',
      code: m.code || '',
      is_host: !!m.is_host,
      host_user_id: m.host_user_id,
      raw: m
    };
  }

  async function leaveSharedMap(mapId) {
    var sb = getSb() || window.__rsSb;
    if (!sb) throw new Error('Not ready');
    var { error } = await sb.rpc('leave_shared_map', { p_map_id: mapId });
    if (error) throw error;
    var vs = C.getViewState && C.getViewState();
    if (vs && vs.mode === 'shared' && String(vs.sharedMapId) === String(mapId)) {
      // Fall back to default private map
      var pmaps = await listPrivateMaps();
      var def = (pmaps || []).find(function (m) { return m.is_default; }) || (pmaps || [])[0];
      if (def) await switchToPrivate(def.id);
      else {
        vs.mode = 'private';
        vs.sharedMapId = null;
        vs.sharedMapName = '';
        vs.sharedMapCode = '';
        try { localStorage.setItem('reg_slayer_view_v1', JSON.stringify(vs)); } catch (e) {}
        updateBrandName();
      }
    }
    saveMapAlias('shared', mapId, null);
    if (mapsUiSelected.kind === 'shared' && String(mapsUiSelected.id) === String(mapId)) {
      mapsUiSelected = { kind: null, id: null };
    }
  }

  /**
   * Host kicks a member. Server also rotates the 6-digit invite code so the
   * kicked user cannot rejoin with the old code. Map data / other members unchanged.
   * @returns {Promise<string|null>} new invite code when provided by the RPC
   */
  async function removeSharedMember(mapId, userId) {
    var sb = getSb() || window.__rsSb;
    if (!sb) throw new Error('Not ready');
    var { data, error } = await sb.rpc('remove_shared_map_member', {
      p_map_id: mapId,
      p_user_id: userId
    });
    if (error) throw error;
    // RPC returns the new 6-digit code (text). Older boolean responses are ignored.
    var newCode = (typeof data === 'string' && /^\d{6}$/.test(data)) ? data : null;
    if (newCode) {
      try {
        var vs = C.getViewState && C.getViewState();
        if (vs && String(vs.sharedMapId) === String(mapId)) {
          vs.sharedMapCode = newCode;
          try { localStorage.setItem('reg_slayer_view_v1', JSON.stringify(vs)); } catch (eV) {}
          updateBrandName();
        }
      } catch (eVs) {}
      try {
        if (window.RegSlayerCloud && window.RegSlayerCloud.getViewState) {
          // keep in sync if auth-sync holds the same object (already mutated above)
        }
      } catch (eC) {}
    }
    return newCode;
  }

  async function deleteSharedMap(mapId) {
    var sb = getSb() || window.__rsSb;
    if (!sb) throw new Error('Not ready');
    var { error } = await sb.rpc('delete_shared_map', { p_map_id: mapId });
    if (error) throw error;
    var vs = C.getViewState && C.getViewState();
    if (vs && vs.mode === 'shared' && String(vs.sharedMapId) === String(mapId)) {
      var pmaps = await listPrivateMaps();
      var def = (pmaps || []).find(function (m) { return m.is_default; }) || (pmaps || [])[0];
      if (def) await switchToPrivate(def.id);
    }
    saveMapAlias('shared', mapId, null);
    if (mapsUiSelected.kind === 'shared' && String(mapsUiSelected.id) === String(mapId)) {
      mapsUiSelected = { kind: null, id: null };
    }
  }

  async function deletePrivateMap(mapId) {
    var sb = getSb() || window.__rsSb;
    if (!sb) throw new Error('Not ready');
    var { error } = await sb.rpc('delete_private_map', { p_id: mapId });
    if (error) throw error;
    var vs = C.getViewState && C.getViewState();
    if (vs && (vs.mode === 'private' || vs.mode === 'personal') && String(vs.privateMapId) === String(mapId)) {
      var pmaps = await listPrivateMaps();
      var def = (pmaps || []).find(function (m) { return m.is_default; }) || (pmaps || [])[0];
      if (def) await switchToPrivate(def.id);
    }
    saveMapAlias('private', mapId, null);
    if (mapsUiSelected.kind === 'private' && String(mapsUiSelected.id) === String(mapId)) {
      mapsUiSelected = { kind: null, id: null };
    }
  }

  function closeAllMapGearMenus() {
    try {
      document.querySelectorAll('.settings-map-row.gear-open').forEach(function (el) {
        el.classList.remove('gear-open');
      });
    } catch (e) {}
  }

  function openMapGearMenu(card) {
    closeAllMapGearMenus();
    var row = document.querySelector('.settings-map-row[data-kind="' + card.kind + '"][data-id="' + card.id + '"]');
    if (!row) return;
    row.classList.add('gear-open');
    var menu = row.querySelector('.settings-map-gear-menu');
    if (!menu) return;
    var isHost = !!card.is_host || card.kind === 'private';
    var html = '';
    if (card.kind === 'private' || isHost) {
      html += '<button type="button" class="settings-subbtn smc-gear-rename" data-kind="' + card.kind + '" data-id="' + card.id + '">Rename map</button>';
    } else if (card.kind === 'shared' && !isHost) {
      // Still offer Rename so non-hosts get a clear “creator only” popup instead of a silent missing action
      html += '<button type="button" class="settings-subbtn smc-gear-rename-locked" data-id="' + card.id + '">Rename map</button>';
    }
    if (card.kind === 'shared' && !isHost) {
      html += '<button type="button" class="settings-subbtn smc-gear-leave" data-id="' + card.id + '">Leave map</button>';
    }
    if (card.kind === 'shared' && isHost) {
      html += '<button type="button" class="settings-subbtn danger smc-gear-delete" data-kind="shared" data-id="' + card.id + '">Delete map</button>';
    }
    if (card.kind === 'private') {
      html += '<button type="button" class="settings-subbtn danger smc-gear-delete" data-kind="private" data-id="' + card.id + '">Delete map</button>';
    }
    html += '<button type="button" class="settings-subbtn smc-gear-cancel">Cancel</button>';
    menu.innerHTML = html;

    var ren = menu.querySelector('.smc-gear-rename');
    if (ren) ren.onclick = function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      closeAllMapGearMenus();
      promptRenameMap(card);
    };
    var renLocked = menu.querySelector('.smc-gear-rename-locked');
    if (renLocked) renLocked.onclick = function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      closeAllMapGearMenus();
      if (typeof window.showCreatorOnlyNotice === 'function') {
        window.showCreatorOnlyNotice(
          'Only the map creator can rename this map. You can leave the map or ask the host to rename it for everyone.',
          'Map creator only'
        );
      } else {
        alert('Only the map creator can rename this map.');
      }
    };
    var leave = menu.querySelector('.smc-gear-leave');
    if (leave) leave.onclick = function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      closeAllMapGearMenus();
      if (!confirm('Leave this shared map? You can rejoin later with the invite code.')) return;
      leaveSharedMap(card.id).then(function () {
        refreshMapsUi();
      }).catch(function (e) { alert(e.message || e); });
    };
    var del = menu.querySelector('.smc-gear-delete');
    if (del) del.onclick = function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      closeAllMapGearMenus();
      var msg = card.kind === 'shared'
        ? 'Delete this shared map for everyone? Members will lose access. This cannot be undone.'
        : 'Delete this private map? Pins and drawings on it will be removed from the cloud copy.';
      if (!confirm(msg)) return;
      var p = card.kind === 'shared' ? deleteSharedMap(card.id) : deletePrivateMap(card.id);
      p.then(function () { refreshMapsUi(); }).catch(function (e) { alert(e.message || e); });
    };
    var cancel = menu.querySelector('.smc-gear-cancel');
    if (cancel) cancel.onclick = function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      closeAllMapGearMenus();
    };
  }

  function promptRenameMap(card) {
    var current = displayMapName(card.kind, card.id, card.name);
    var n = prompt('New map name:', current);
    if (n == null) return;
    n = String(n).trim().slice(0, 60);
    if (!n) return;
    if (card.kind === 'private') {
      renamePrivate(card.id, n).then(function () {
        saveMapAlias('private', card.id, null);
        refreshMapsUi();
      }).catch(function (e) { alert(e.message || e); });
      return;
    }
    // Shared: only creator reaches here — ask everyone vs just me
    showSimpleModal('Rename map',
      '<p class="settings-status">Rename to <strong>' + esc(n) + '</strong>?</p>' +
      '<p class="settings-status">Rename for everyone updates the name on all members’ screens. “Just me” only changes what you see.</p>',
      [
        {
          label: 'Rename for everyone',
          primary: true,
          onClick: function () {
            var sb = getSb() || window.__rsSb;
            if (!sb) { alert('Not ready'); return; }
            sb.rpc('rename_shared_map', { p_id: card.id, p_name: n }).then(function (r) {
              if (r.error) throw r.error;
              saveMapAlias('shared', card.id, null);
              var vs = C.getViewState && C.getViewState();
              if (vs && vs.mode === 'shared' && String(vs.sharedMapId) === String(card.id)) {
                vs.sharedMapName = (r.data && r.data.name) || n;
                try { localStorage.setItem('reg_slayer_view_v1', JSON.stringify(vs)); } catch (e) {}
                updateBrandName();
              }
              refreshMapsUi();
            }).catch(function (e) { alert(e.message || e); });
          }
        },
        {
          label: 'Just me',
          onClick: function () {
            saveMapAlias('shared', card.id, n);
            var vs = C.getViewState && C.getViewState();
            if (vs && vs.mode === 'shared' && String(vs.sharedMapId) === String(card.id)) {
              // Brand can show personal alias while viewing
              updateBrandName();
            }
            refreshMapsUi();
          }
        },
        { label: 'Cancel' }
      ]
    );
  }

  function buildPartyMembersHtml(members, vs, user) {
    if (!members || !members.length) {
      return '<p class="settings-hint">Only you on this map so far.</p>';
    }
    return members.map(function (m) {
      var pref = partyPrefs[m.user_id] || {};
      var nick = pref.nickname || '';
      var col = pref.arrow_color || m.arrow_color || '#2563eb';
      var show = pref.show_content !== false && !hiddenContentOwners[m.user_id];
      var self = user && m.user_id === user.id;
      return '<div class="party-member-row" data-uid="' + m.user_id + '">' +
        '<div class="party-member-head">' +
          '<span class="party-dot" style="background:' + esc(col) + '"></span>' +
          '<strong>' + esc(memberLabel(m)) + '</strong>' +
          (self ? ' <span class="settings-hint">(you)</span>' : '') +
          (m.is_host ? ' · host' : '') +
        '</div>' +
        (!self ? (
          '<label class="settings-row"><input type="checkbox" class="party-show-content" ' + (show ? 'checked' : '') + '>' +
          '<span class="sr-text">Show their pins/areas on map</span></label>' +
          '<div class="settings-inline-row"><input type="text" class="party-nick" placeholder="Nickname" value="' + esc(nick) + '">' +
          '<input type="color" class="party-color" value="' + esc(col) + '" title="Arrow color" style="width:44px;height:36px;padding:0;border:none;">' +
          '<button type="button" class="party-save">Save</button></div>'
        ) : '') +
      '</div>';
    }).join('');
  }

  function openPartyMemberCustomize(member, mapId, mapMeta) {
    var user = getUser() || window.__rsUser;
    var self = user && member && member.user_id === user.id;
    var iAmHost = !!(mapMeta && mapMeta.is_host);
    var pref = partyPrefs[member.user_id] || {};
    var nick = pref.nickname || '';
    var col = pref.arrow_color || member.arrow_color || (self ? myArrowColor : '#2563eb');
    var dirId = self
      ? (myDirIconId || null)
      : ((Object.prototype.hasOwnProperty.call(pref, 'direction_icon_id') && pref.direction_icon_id)
        ? pref.direction_icon_id
        : null);
    var show = pref.show_content !== false && !hiddenContentOwners[member.user_id];
    var label = memberLabel(member) || 'Hunter';
    var scale = self ? (myDirIconScale || 1) : memberIconScale(member);
    var scalePct = Math.round(scale * 100);
    var isHidden = !!pref.marker_hidden;
    var baseName = member.display_name || member.username || 'Hunter';
    var title = self
      ? ('Your marker' + (member.is_host ? ' · host' : ''))
      : (nick ? (nick + ' — ' + baseName) : ('Customize ' + label));
    var body =
      (!self
        ? ('<div style="display:flex;align-items:center;gap:6px;margin:0 0 6px;">' +
            '<button type="button" class="settings-subbtn" id="rs-mem-nick-btn" style="flex:1;margin:0;text-align:left;padding:7px 8px;">' +
              (nick ? ('Nickname: ' + esc(nick)) : 'Nickname') +
            '</button>' +
            '<input type="color" id="rs-mem-color" value="' + esc(col) + '" title="Marker color" ' +
              'style="width:42px;height:36px;padding:0;border:1px solid #444;border-radius:8px;background:transparent;cursor:pointer;flex:0 0 auto;">' +
          '</div>' +
          '<input type="text" id="rs-mem-nick" maxlength="32" value="' + esc(nick) + '" placeholder="Type a nickname…" ' +
            'style="display:none;width:100%;box-sizing:border-box;padding:7px;border-radius:6px;border:1px solid #444;background:#1a1a1a;color:#fff;margin:0 0 6px;font-size:12px;">')
        : ('<div style="display:flex;align-items:center;gap:6px;margin:0 0 6px;">' +
            '<span class="settings-hint" style="flex:1;margin:0;font-size:11px;font-weight:700;">Marker color</span>' +
            '<input type="color" id="rs-mem-color" value="' + esc(col) + '" title="Marker color" ' +
              'style="width:42px;height:36px;padding:0;border:1px solid #444;border-radius:8px;background:transparent;cursor:pointer;flex:0 0 auto;">' +
          '</div>')) +
      '<button type="button" class="settings-subbtn" id="rs-mem-dir-btn" data-mode="' + (self ? 'self' : 'friend') +
        '" style="width:100%;margin:0 0 6px;padding:6px 8px;">' +
        changeMarkerBtnInnerHtml(dirId, col, scale, self ? 'self' : 'friend') +
      '</button>' +
      '<input type="hidden" id="rs-mem-dir" value="' + esc(dirId || '') + '">' +
      '<input type="hidden" id="rs-mem-size" value="' + scalePct + '">' +
      (!self
        ? ('<button type="button" class="settings-subbtn" id="rs-mem-hide-btn" style="width:100%;margin:0 0 4px;padding:7px 8px;' +
            (isHidden ? 'background:#1a4a5c;border-color:#2a6a7c;' : '') + '">' +
            (isHidden ? 'Unhide' : 'Hide') + '</button>' +
          '<label class="settings-row" style="border:none;padding:2px 0;font-size:11px;"><input type="checkbox" id="rs-mem-show" ' +
            (show ? 'checked' : '') + '><span class="sr-text">Show their pins/areas</span></label>')
        : '');
    var buttons = [
      {
        label: 'Save',
        primary: true,
        onClick: function () {
          var st = readEditFormMarkerState('rs-mem');
          var nickEl = $('rs-mem-nick');
          var showEl = $('rs-mem-show');
          var n = nickEl ? nickEl.value.trim() : '';
          var fields = {
            nickname: n || null,
            arrow_color: st.color || '#2563eb',
            direction_icon_id: st.iconId,
            icon_scale: st.scale
          };
          if (!self && showEl) {
            fields.show_content = !!showEl.checked;
            if (!showEl.checked) hiddenContentOwners[member.user_id] = true;
            else delete hiddenContentOwners[member.user_id];
            try {
              localStorage.setItem(HIDDEN_MEMBERS_KEY + ':' + mapId, JSON.stringify(hiddenContentOwners));
            } catch (eH) {}
          }
          if (self) {
            myArrowColor = st.color || myArrowColor;
            myDirIconId = st.iconId || null;
            myDirIconScale = st.scale;
            try { localStorage.setItem(ARROW_KEY, myArrowColor); } catch (eA) {}
            try {
              if (myDirIconId) localStorage.setItem(DIR_ICON_KEY, myDirIconId);
              else localStorage.removeItem(DIR_ICON_KEY);
              localStorage.setItem(DIR_SCALE_KEY, String(myDirIconScale));
            } catch (eD) {}
            try { document.documentElement.style.setProperty('--gps-arrow-color', myArrowColor); } catch (eCss) {}
            try {
              var sbP = getSb();
              if (sbP && user) {
                sbP.from('profiles').update({
                  arrow_color: myArrowColor,
                  direction_icon_id: myDirIconId
                }).eq('id', user.id).then(function () {});
              }
            } catch (eProf) {}
            try { syncMyDirIconSettingsBtn(); } catch (eB) {}
          }
          if (!self) fields.direction_icon_id = st.iconId || null;
          return savePartyPref(member.user_id, fields, mapId).then(function () {
            if (self) {
              try {
                if (typeof setGpsMarker === 'function' && typeof userLat !== 'undefined' && userLat != null) {
                  setGpsMarker(userLat, userLng);
                }
              } catch (eG) {}
            } else {
              rebuildPartyMemberIcon(member.user_id);
            }
            applyContentOwnerFilter();
            setTimeout(function () {
              try { pullPresence(); } catch (eP) {}
              try { refreshMapsUi(); } catch (eR) {}
            }, 50);
          });
        }
      }
    ];
    // Host / map creator only — kick non-host members (also rotates invite code)
    if (iAmHost && !self && !member.is_host) {
      var kickName = (nick && String(nick).trim()) || label || baseName || 'member';
      buttons.push({
        label: 'Kick ' + kickName + ' from map',
        onClick: function () {
          if (!confirm(
            'Kick ' + kickName + ' from this map?\n\n' +
            'The 6-digit invite code will change so they cannot rejoin with the old code. ' +
            'Other members stay on the map; nothing else changes.'
          )) return;
          return removeSharedMember(mapId, member.user_id).then(function (newCode) {
            refreshMapsUi();
            try {
              if (window.showAppCopyToast) {
                showAppCopyToast(
                  '<span class="act">Kicked ' + esc(kickName) + '</span><br>' +
                  (newCode
                    ? ('New invite code: <strong>' + esc(newCode) + '</strong>')
                    : 'Invite code rotated — share the new code with remaining members')
                );
              } else if (newCode) {
                alert('Kicked ' + kickName + '.\nNew invite code: ' + newCode +
                  '\nShare this code with anyone who still needs to join.');
              }
            } catch (eT) {}
          }).catch(function (e) {
            if (typeof window.showCreatorOnlyNotice === 'function') {
              window.showCreatorOnlyNotice(
                (e && e.message) || 'Only the map creator can remove members.',
                'Map creator only'
              );
            } else {
              alert(e.message || e);
            }
          });
        }
      });
    }
    buttons.push({ label: 'Cancel' });
    showSimpleModal(title, body, buttons, { compact: true });
    setTimeout(function () {
      wireFriendEditForm({
        prefix: 'rs-mem',
        mode: self ? 'self' : 'friend',
        titleBase: baseName,
        uid: member.user_id,
        isSelf: self
      });
    }, 30);
  }

  async function fillSelectedMapMembersPanel(smaps) {
    var panel = $('set-map-members-panel');
    if (!panel) return;
    if (!mapsUiSelected || mapsUiSelected.kind !== 'shared' || !mapsUiSelected.id) {
      panel.innerHTML = '';
      return;
    }
    var mapId = mapsUiSelected.id;
    var mapRow = (smaps || []).find(function (x) { return String(x.id) === String(mapId); });
    var mapName = displayMapName('shared', mapId, (mapRow && mapRow.name) || 'Shared map');
    panel.innerHTML = '<div class="smm-title">Members · ' + esc(mapName) + '</div>' +
      '<p class="settings-status">Loading…</p>';
    try {
      await loadPartyPrefs(mapId);
      var members = await listMembersForMap(mapId);
      // Cache for active map listMembers path
      var vs = C.getViewState && C.getViewState();
      if (vs && vs.mode === 'shared' && vs.sharedMapId === mapId) {
        window.__rsPartyMembers = members;
      }
      var user = getUser() || window.__rsUser;
      if (!members.length) {
        panel.innerHTML = '<div class="smm-title">Members · ' + esc(mapName) + '</div>' +
          '<p class="settings-status">No members listed yet. View the map and share an invite.</p>';
        return;
      }
      var mapMeta = {
        is_host: !!(mapRow && (mapRow.is_host || (user && mapRow.host_user_id === user.id)))
      };
      // Also detect host from members list
      if (!mapMeta.is_host && user) {
        var me = members.find(function (x) { return String(x.user_id) === String(user.id); });
        if (me && me.is_host) mapMeta.is_host = true;
      }
      panel.innerHTML = '<div class="smm-title">Members · ' + esc(mapName) + '</div>' +
        members.map(function (m) {
          var self = user && m.user_id === user.id;
          var col = memberColor(m);
          var meta = (self ? 'you' : '') + (m.is_host ? (self ? ' · host' : 'host') : '');
          var iconId = self ? (myDirIconId || null) : memberDirIconId(m);
          var scale = self ? (myDirIconScale || 1) : memberIconScale(m);
          var glyphPx = Math.max(14, Math.min(22, Math.round(18 * scale)));
          var glyphHtml;
          if (iconId && getDirIconById(iconId)) {
            glyphHtml = dirIconUprightPreview(iconId, col, glyphPx);
          } else {
            var aw = Math.round(glyphPx * 0.75);
            var ah = Math.round(glyphPx * 1.05);
            glyphHtml =
              '<svg viewBox="0 0 24 32" width="' + aw + '" height="' + ah +
                '" aria-hidden="true" style="display:block;">' +
                '<path d="M12 1.5 L22.5 29.5 L12 23.2 L1.5 29.5 Z" fill="' +
                normalizeDirHex(col) + '" stroke="#000" stroke-width="0.9" stroke-linejoin="round"/>' +
              '</svg>';
          }
          return '<button type="button" class="smm-member settings-subbtn" data-uid="' + esc(m.user_id) + '">' +
            '<span class="smm-marker" title="Marker color &amp; icon">' + glyphHtml + '</span>' +
            '<span class="smm-label">' + esc(memberLabel(m)) + '</span>' +
            (meta ? '<span class="smm-meta">' + esc(meta) + '</span>' : '') +
          '</button>';
        }).join('');
      panel.querySelectorAll('.smm-member').forEach(function (btn) {
        btn.onclick = function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          var uid = btn.getAttribute('data-uid');
          var mem = members.find(function (x) { return String(x.user_id) === String(uid); });
          if (mem) openPartyMemberCustomize(mem, mapId, mapMeta);
        };
      });
    } catch (eMem) {
      panel.innerHTML = '<div class="smm-title">Members · ' + esc(mapName) + '</div>' +
        '<p class="settings-status">Could not load members' +
        (eMem && eMem.message ? ': ' + esc(eMem.message) : '') + '.</p>';
    }
  }

  function mapRowHtml(card) {
    var selected = mapsUiSelected.kind === card.kind && String(mapsUiSelected.id) === String(card.id);
    var shown = displayMapName(card.kind, card.id, card.name);
    var badges = '';
    if (card.active) {
      badges += '<span class="smc-state-badge smc-viewing" title="Currently open on the map">Viewing</span>';
    }
    if (selected && !card.active) {
      badges += '<span class="smc-state-badge smc-inspect" title="Selected for map info / members">Selected</span>';
    }
    return '<div class="settings-map-row' +
      (card.active ? ' is-active' : '') +
      (selected ? ' is-selected' : '') +
      '" data-kind="' + card.kind + '" data-id="' + card.id + '">' +
      '<button type="button" class="smc-gear settings-subbtn" data-kind="' + card.kind + '" data-id="' + card.id +
        '" title="Map options" aria-label="Map options">⚙</button>' +
      '<button type="button" class="smc-name settings-subbtn" data-kind="' + card.kind + '" data-id="' + card.id + '" title="' +
        esc(shown) + (selected && !card.active ? ' (selected for info)' : '') +
        (card.active ? ' (currently viewing)' : '') + '">' + esc(shown) + '</button>' +
      badges +
      '<button type="button" class="smc-share settings-subbtn" data-kind="' + card.kind + '" data-id="' + card.id + '">Share</button>' +
      '<button type="button" class="smc-view settings-subbtn" data-kind="' + card.kind + '" data-id="' + card.id + '">View Map</button>' +
      '<div class="settings-map-gear-menu" role="menu"></div>' +
    '</div>';
  }

  async function refreshMapsUi() {
    updateShareLocBtn();
    var allBox = $('set-all-maps-list');
    var privBox = $('set-private-maps-list');
    var sharedBox = $('set-shared-maps-list');
    var modeLabel = $('set-map-mode-label');
    var membersPanel = $('set-map-members-panel');
    var vs = C.getViewState && C.getViewState();

    var pmaps = [];
    var smaps = [];
    try { pmaps = await listPrivateMaps(); } catch (eP) { pmaps = []; }
    try {
      if (C.listMySharedMaps) smaps = await C.listMySharedMaps();
      if (!smaps || !smaps.length) {
        var sb0 = getSb() || window.__rsSb;
        if (sb0) {
          var r0 = await sb0.rpc('list_my_shared_maps');
          smaps = r0.data || [];
        }
      }
    } catch (eS) { smaps = []; }

    // Refresh active-map name from live lists so mobile chip/title match what you're viewing
    try { syncViewStateNamesFromLists(pmaps, smaps); } catch (eSn) {}
    try { updateBrandName(); } catch (eBn) {}
    vs = C.getViewState && C.getViewState();

    // Sort: private (not shared) first by name, then shared by name
    pmaps = (pmaps || []).slice().sort(function (a, b) {
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    smaps = (smaps || []).slice().sort(function (a, b) {
      return String(a.name || '').localeCompare(String(b.name || ''));
    });

    var privateCards = pmaps.map(function (m) {
      return {
        kind: 'private',
        id: m.id,
        name: m.name || 'Private map',
        is_default: !!m.is_default,
        is_host: true,
        active: !!(vs && (vs.mode === 'private' || vs.mode === 'personal') && vs.privateMapId === m.id),
        raw: m
      };
    });
    var sharedCards = (smaps || []).map(function (m) {
      return {
        kind: 'shared',
        id: m.id,
        name: m.name || 'Shared map',
        code: m.code || '',
        is_host: !!m.is_host,
        host_user_id: m.host_user_id,
        active: !!(vs && vs.mode === 'shared' && vs.sharedMapId === m.id),
        raw: m
      };
    });

    // Default selection to currently viewed map
    if (!mapsUiSelected.id && vs) {
      if (vs.mode === 'shared' && vs.sharedMapId) {
        mapsUiSelected = { kind: 'shared', id: vs.sharedMapId };
      } else if (vs.privateMapId) {
        mapsUiSelected = { kind: 'private', id: vs.privateMapId };
      }
    }

    if (allBox) {
      if (!privateCards.length && !sharedCards.length) {
        allBox.innerHTML = '<p class="settings-status">No maps yet. Create a private or shared map below.</p>';
      } else {
        var html = '';
        html += '<div class="settings-maps-group">';
        html += '<div class="settings-maps-group-title">Not shared</div>';
        if (!privateCards.length) {
          html += '<p class="settings-status">No private maps yet.</p>';
        } else {
          html += privateCards.map(mapRowHtml).join('');
        }
        html += '</div>';
        html += '<div class="settings-maps-group">';
        html += '<div class="settings-maps-group-title">Shared</div>';
        if (!sharedCards.length) {
          html += '<p class="settings-status">No shared maps yet.</p>';
        } else {
          html += sharedCards.map(mapRowHtml).join('');
        }
        html += '</div>';
        allBox.innerHTML = html;

        function findCard(kind, id) {
          var list = kind === 'shared' ? sharedCards : privateCards;
          return list.find(function (c) { return String(c.id) === String(id); });
        }
        allBox.querySelectorAll('.smc-gear').forEach(function (btn) {
          btn.onclick = function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            var kind = btn.getAttribute('data-kind');
            var id = btn.getAttribute('data-id');
            var card = findCard(kind, id);
            if (!card) return;
            var row = btn.closest('.settings-map-row');
            if (row && row.classList.contains('gear-open')) {
              closeAllMapGearMenus();
              return;
            }
            openMapGearMenu(card);
          };
        });
        allBox.querySelectorAll('.smc-name').forEach(function (btn) {
          btn.onclick = function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            closeAllMapGearMenus();
            var kind = btn.getAttribute('data-kind');
            var id = btn.getAttribute('data-id');
            if (mapsUiSelected.kind === kind && String(mapsUiSelected.id) === String(id)) {
              // Toggle off only for shared (hide members); keep private selection light
              if (kind === 'shared') mapsUiSelected = { kind: null, id: null };
            } else {
              mapsUiSelected = { kind: kind, id: id };
            }
            refreshMapsUi();
          };
        });
        allBox.querySelectorAll('.smc-view').forEach(function (btn) {
          btn.onclick = function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            closeAllMapGearMenus();
            var kind = btn.getAttribute('data-kind');
            var id = btn.getAttribute('data-id');
            mapsUiSelected = { kind: kind, id: id };
            if (kind === 'private') {
              switchToPrivate(id).then(function () {
                refreshMapsUi();
              }).catch(function (e) { alert(e.message || e); });
            } else if (C.switchToShared) {
              C.switchToShared(id).then(function () {
                refreshMapsUi();
                pullPresence();
              }).catch(function (e) { alert(e.message || e); });
            }
          };
        });
        allBox.querySelectorAll('.smc-share').forEach(function (btn) {
          btn.onclick = function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            closeAllMapGearMenus();
            var kind = btn.getAttribute('data-kind');
            var id = btn.getAttribute('data-id');
            if (kind === 'shared') {
              var row = (smaps || []).find(function (x) { return String(x.id) === String(id); });
              if (row) {
                copyMapInvite(row);
              } else {
                // Fallback: rebuild from card name if list row missing
                var card = findCard('shared', id);
                if (card && card.raw) copyMapInvite(card.raw);
                else if (card) copyMapInvite({ id: card.id, name: card.name, code: card.code || (card.raw && card.raw.code) });
                else alert('Could not find invite code for this map.');
              }
            } else {
              var pcard = findCard('private', id);
              var pname = (pcard && pcard.name) || 'Hunt map';
              sharePrivateMapAsInvite(id, pname);
            }
          };
        });
      }
    }

    // Click outside closes gear menus
    if (!document._rsMapGearOutside) {
      document._rsMapGearOutside = true;
      document.addEventListener('click', function (ev) {
        if (ev.target && ev.target.closest && ev.target.closest('.settings-map-row')) return;
        closeAllMapGearMenus();
      }, true);
    }

    await fillSelectedMapMembersPanel(smaps);

    if (privBox) privBox.innerHTML = '';
    if (sharedBox) sharedBox.innerHTML = '';

    if (vs && vs.mode === 'shared' && vs.sharedMapId) {
      pullPresence();
    } else {
      clearPartyMarkers();
    }

    renderOverlayParty();
  }

  function applyContentOwnerFilter() {
    // Filter pins/areas/hunts by ownerId when drawing — set flag for draw hooks
    window.__rsHiddenContentOwners = hiddenContentOwners;
    try {
      if (typeof drawPinsOnMap === 'function') drawPinsOnMap();
      if (typeof drawHuntsOnMap === 'function') drawHuntsOnMap();
      if (typeof drawCustomAreasOnMap === 'function') drawCustomAreasOnMap();
    } catch (e) {}
  }

  function renderOverlayParty() {
    var box = $('ml-party-list');
    var fold = $('ml-fold-body-party');
    var vs = C.getViewState && C.getViewState();
    if (!box) return;
    if (!vs || vs.mode !== 'shared') {
      box.innerHTML = '<p class="settings-hint" style="font-size:11px;">Open a shared map to see party members.</p>';
      return;
    }
    var members = window.__rsPartyMembers || [];
    if (!members.length) {
      box.innerHTML = '<p class="settings-hint" style="font-size:11px;">Loading party…</p>';
      listMembers().then(function () { renderOverlayParty(); refreshMapsUi(); });
      return;
    }
    box.innerHTML = members.map(function (m) {
      var show = !hiddenContentOwners[m.user_id];
      return '<label class="ml-option"><input type="checkbox" data-party-uid="' + m.user_id + '" ' + (show ? 'checked' : '') + '>' +
        '<span class="ml-opt-text">' + esc(memberLabel(m)) + ' <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + esc(memberColor(m)) + ';vertical-align:middle;"></span></span></label>';
    }).join('') +
      '<p class="settings-hint" style="font-size:10px;margin:6px 0 0;">Uncheck hides their pins/areas. Live location always shows while they share.</p>';
    box.querySelectorAll('[data-party-uid]').forEach(function (inp) {
      inp.onchange = function () {
        var uid = inp.getAttribute('data-party-uid');
        if (!inp.checked) hiddenContentOwners[uid] = true;
        else delete hiddenContentOwners[uid];
        try {
          localStorage.setItem(HIDDEN_MEMBERS_KEY + ':' + vs.sharedMapId, JSON.stringify(hiddenContentOwners));
        } catch (e) {}
        applyContentOwnerFilter();
      };
    });
  }

  // ---- Share entity to another map ----
  var MAP_VISIT_KEY = 'reg_slayer_map_visit_order_v1';

  /** Record map open so share-to-map dropdown can sort by last visited. */
  function recordMapVisit(kind, id) {
    if (!kind || !id) return;
    var list = [];
    try { list = JSON.parse(localStorage.getItem(MAP_VISIT_KEY) || '[]'); } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    var kid = String(kind);
    var mid = String(id);
    list = list.filter(function (x) {
      return !(x && String(x.kind) === kid && String(x.id) === mid);
    });
    list.unshift({ kind: kid, id: mid, t: Date.now() });
    if (list.length > 50) list = list.slice(0, 50);
    try { localStorage.setItem(MAP_VISIT_KEY, JSON.stringify(list)); } catch (e2) {}
  }

  function mapVisitIndex(kind, id) {
    try {
      var list = JSON.parse(localStorage.getItem(MAP_VISIT_KEY) || '[]');
      if (!Array.isArray(list)) return 9999;
      var kid = String(kind), mid = String(id);
      for (var i = 0; i < list.length; i++) {
        if (list[i] && String(list[i].kind) === kid && String(list[i].id) === mid) return i;
      }
    } catch (e) {}
    return 9999;
  }

  function recordVisitFromViewState() {
    try {
      var vs = C.getViewState && C.getViewState();
      if (!vs) return;
      if (vs.mode === 'shared' && vs.sharedMapId) recordMapVisit('shared', vs.sharedMapId);
      else if (vs.privateMapId) recordMapVisit('private', vs.privateMapId);
    } catch (e) {}
  }

  async function listAllTargetMaps() {
    var out = [];
    try {
      var p = await listPrivateMaps();
      p.forEach(function (m) {
        out.push({
          kind: 'private',
          id: m.id,
          name: String(m.name || 'My Map').trim() || 'My Map'
        });
      });
    } catch (e) {}
    try {
      var sb = window.__rsSb;
      var r = await sb.rpc('list_my_shared_maps');
      (r.data || []).forEach(function (m) {
        out.push({
          kind: 'shared',
          id: m.id,
          name: String(m.name || 'Shared map').trim() || 'Shared map',
          code: m.code
        });
      });
    } catch (e2) {}
    var vs = C.getViewState && C.getViewState();
    // exclude current map
    out = out.filter(function (m) {
      if (!vs) return true;
      if (vs.mode === 'shared' && m.kind === 'shared' && m.id === vs.sharedMapId) return false;
      if ((vs.mode === 'private' || vs.mode === 'personal') && m.kind === 'private' && m.id === vs.privateMapId) return false;
      return true;
    });
    // Sort by last visited (most recent first), then name only
    out.sort(function (a, b) {
      var ra = mapVisitIndex(a.kind, a.id);
      var rb = mapVisitIndex(b.kind, b.id);
      if (ra !== rb) return ra - rb;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    return out;
  }

  async function getMapStateRow(kind, id) {
    var sb = window.__rsSb;
    if (kind === 'private') {
      var { data, error } = await sb.from('private_maps').select('map_state, map_revision').eq('id', id).maybeSingle();
      if (error) throw error;
      return data;
    }
    var r = await sb.from('shared_maps').select('map_state, map_revision').eq('id', id).maybeSingle();
    if (r.error) throw r.error;
    return r.data;
  }

  async function putMapStateRow(kind, id, state, rev) {
    var sb = window.__rsSb;
    if (kind === 'private') {
      var { error } = await sb.from('private_maps').update({
        map_state: state,
        map_revision: rev,
        updated_at: new Date().toISOString()
      }).eq('id', id);
      if (error) throw error;
      return;
    }
    var r = await sb.from('shared_maps').update({
      map_state: state,
      map_revision: rev,
      updated_at: new Date().toISOString()
    }).eq('id', id);
    if (r.error) throw r.error;
  }

  function stampOwner(entity) {
    var user = window.__rsUser;
    var prof = C.getProfile && C.getProfile();
    if (!entity || !user) return entity;
    entity.ownerId = user.id;
    entity.ownerName = (prof && prof.username) || 'me';
    entity.updatedAt = new Date().toISOString();
    return entity;
  }

  /** Reload full pin/hunt/stand/shape from local data so share keeps every field. */
  function hydrateShareEntity(entity) {
    if (!entity || typeof entity !== 'object') return {};
    var id = entity.id != null ? String(entity.id) : '';
    if (id && typeof locations !== 'undefined' && Array.isArray(locations)) {
      for (var i = 0; i < locations.length; i++) {
        if (locations[i] && String(locations[i].id) === id) {
          try { return JSON.parse(JSON.stringify(locations[i])); } catch (eC) { return locations[i]; }
        }
      }
    }
    if (id) {
      try {
        var pins = JSON.parse(localStorage.getItem('alabama_hunt_custom_pins') || '[]');
        if (Array.isArray(pins)) {
          for (var p = 0; p < pins.length; p++) {
            if (pins[p] && String(pins[p].id) === id) {
              return JSON.parse(JSON.stringify(pins[p]));
            }
          }
        }
      } catch (eP) {}
      try {
        var hunts = JSON.parse(localStorage.getItem('alabama_hunt_historical_hunts') || '[]');
        if (Array.isArray(hunts)) {
          for (var h = 0; h < hunts.length; h++) {
            if (hunts[h] && String(hunts[h].id) === id) {
              return JSON.parse(JSON.stringify(hunts[h]));
            }
          }
        }
      } catch (eH) {}
      try {
        var areas = JSON.parse(localStorage.getItem('alabama_hunt_custom_areas_v1') || '[]');
        if (Array.isArray(areas)) {
          for (var a = 0; a < areas.length; a++) {
            if (areas[a] && String(areas[a].id) === id) {
              return JSON.parse(JSON.stringify(areas[a]));
            }
          }
        }
      } catch (eA) {}
      try {
        var paths = JSON.parse(localStorage.getItem('alabama_hunt_measured_paths_v1') || '[]');
        if (Array.isArray(paths)) {
          for (var m = 0; m < paths.length; m++) {
            if (paths[m] && String(paths[m].id) === id) {
              return JSON.parse(JSON.stringify(paths[m]));
            }
          }
        }
      } catch (eM) {}
    }
    try { return JSON.parse(JSON.stringify(entity)); } catch (e2) { return entity; }
  }

  function inferShareType(entity, defaultType) {
    if (!entity) return defaultType || 'pin';
    if (entity.isCustomArea || entity.ring || entity.polygon || entity.areaType) return 'area';
    if (entity.kind === 'track' || entity.kind === 'measure' || (entity.points && entity.points.length)) {
      return defaultType || 'path';
    }
    // Past hunts (not map pins)
    if (entity.date && !entity.isPin && !entity.isStand) return defaultType || 'hunt';
    // Stand / hunt / custom pins all live in the pins array as isPin objects
    if (entity.isPin || entity.isStand || entity.isHunt || entity.iconId || entity.lat != null) {
      return 'pin';
    }
    return defaultType || 'pin';
  }

  /**
   * Exact clone for another map: name, colors, icon, notes, type flags, scale, etc.
   * Only id / ownership / timestamps are refreshed.
   */
  function cloneEntityExact(entity, entityType) {
    var copy;
    try {
      copy = JSON.parse(JSON.stringify(entity || {}));
    } catch (e) {
      copy = Object.assign({}, entity || {});
    }
    // Drop runtime-only flags
    delete copy._tempReveal;
    delete copy._layer;
    delete copy._marker;
    copy.id = (entityType || 'pin') + '_' + Date.now() + '_' + Math.floor(Math.random() * 9999);
    if (!copy.createdAt) copy.createdAt = new Date().toISOString();
    copy.updatedAt = new Date().toISOString();
    if (entityType === 'pin') {
      copy.isPin = true;
      // Preserve isHunt / isStand / colors / icon / notes / pinScale / emphasized / hidden / idealConditions
    } else if (entityType === 'stand') {
      if (copy.isPin) copy.isStand = true;
    } else if (entityType === 'hunt' && copy.isPin) {
      copy.isHunt = true;
    }
    stampOwner(copy);
    return copy;
  }

  async function copyEntityToMap(entity, entityType, target) {
    var row = await getMapStateRow(target.kind, target.id);
    var state = (row && row.map_state) || {};
    state.pins = state.pins || [];
    state.hunts = state.hunts || [];
    state.customAreas = state.customAreas || [];
    state.measuredPaths = state.measuredPaths || [];
    state.stands = state.stands || {};
    var hydrated = hydrateShareEntity(entity);
    var typ = entityType || inferShareType(hydrated, 'pin');
    var copy = cloneEntityExact(hydrated, typ);
    // Exact placement — never drop/re-round coordinates
    if (hydrated.lat != null && hydrated.lng != null) {
      copy.lat = Number(hydrated.lat);
      copy.lng = Number(hydrated.lng);
    }
    if (!isFinite(copy.lat) || !isFinite(copy.lng)) {
      throw new Error('Pin is missing coordinates and cannot be shared.');
    }

    // Map pins (including hunt/stand pins): full object into pins[]
    if (typ === 'pin' || (typ === 'stand' && copy.isPin) || (typ === 'hunt' && copy.isPin)) {
      state.pins.push(copy);
    } else if (typ === 'hunt') {
      state.hunts.push(copy);
    } else if (typ === 'area') {
      if (!copy.isCustomArea) copy.isCustomArea = true;
      state.customAreas.push(copy);
    } else if (typ === 'path') {
      state.measuredPaths.push(copy);
    } else if (typ === 'stand') {
      var key = 'shared';
      if (!Array.isArray(state.stands[key])) state.stands[key] = [];
      state.stands[key].push(copy);
    } else {
      state.pins.push(copy);
    }

    var rev = ((row && row.map_revision) || 0) + 1;
    if (!state.meta) state.meta = {};
    state.meta.revision = rev;
    state.meta.savedAt = new Date().toISOString();
    await putMapStateRow(target.kind, target.id, state, rev);
    // Keep local offline cache for that map in sync so switch shows the shared pin
    try {
      var CACHE_KEY = 'reg_slayer_map_cache_v1';
      var cache = {};
      try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch (eC) { cache = {}; }
      var slot = (target.kind === 'shared' ? 'shared:' : 'private:') + target.id;
      cache[slot] = {
        state: state,
        savedAt: Date.now(),
        name: target.name || target.label || 'Map',
        code: target.code || null
      };
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (eCache) {}
    return copy;
  }

  /** In-progress share session so Select Map can stay in the same popup */
  var shareFlowCtx = null;

  function renderShareChooserInModal(ctx) {
    ctx = ctx || shareFlowCtx || {};
    var label = ctx.label || 'This spot';
    showSimpleModal('Share', '', [
      {
        label: 'Share to another map',
        primary: true,
        close: false,
        onClick: function () {
          openShareToMapFlow(ctx.entity || { lat: ctx.lat, lng: ctx.lng, name: label }, ctx.defaultType || 'pin', {
            fromChooser: true
          });
        }
      },
      {
        label: 'Copy location',
        close: true,
        onClick: function () {
          if (typeof shareLocationLink === 'function') shareLocationLink(ctx.lat, ctx.lng, label);
          else if (typeof googleMapsShareUrl === 'function') {
            var u = googleMapsShareUrl(ctx.lat, ctx.lng);
            if (navigator.clipboard) navigator.clipboard.writeText(u);
            else window.prompt('Copy:', u);
          }
        }
      },
      { label: 'Cancel', close: true }
    ], { reuse: true, cardClass: 'rs-select-map-card' });
  }

  async function openShareToMapFlow(entity, defaultType, opts) {
    opts = opts || {};
    // Close Leaflet popups so the picker is not covered (keep our simple modal)
    try {
      if (typeof map !== 'undefined' && map && typeof map.closePopup === 'function') map.closePopup();
    } catch (ePop) {}
    try {
      document.querySelectorAll('.leaflet-popup').forEach(function (el) {
        try { el.remove(); } catch (eR) {}
      });
    } catch (eLp) {}

    var ent = hydrateShareEntity(entity || {});
    // Minimal lat/lng spot with no full pin record
    if ((ent.lat == null || ent.lng == null) && entity && entity.lat != null) {
      ent.lat = entity.lat;
      ent.lng = entity.lng;
      if (!ent.name && entity.name) ent.name = entity.name;
    }
    // Shapes: derive a center if lat/lng missing
    if ((ent.lat == null || ent.lng == null) && ent.ring && ent.ring.length) {
      try {
        var sx = 0, sy = 0, n = 0;
        for (var ri = 0; ri < ent.ring.length; ri++) {
          var pt = ent.ring[ri];
          var pla = Array.isArray(pt) ? Number(pt[0]) : Number(pt.lat);
          var plo = Array.isArray(pt) ? Number(pt[1]) : Number(pt.lng);
          if (isFinite(pla) && isFinite(plo)) { sx += pla; sy += plo; n++; }
        }
        if (n) { ent.lat = sx / n; ent.lng = sy / n; }
      } catch (eCtr) {}
    }
    if (ent.lat == null || ent.lng == null || !isFinite(Number(ent.lat)) || !isFinite(Number(ent.lng))) {
      alert('Location not available to share.');
      return;
    }
    ent.lat = Number(ent.lat);
    ent.lng = Number(ent.lng);
    var typ = inferShareType(ent, defaultType || 'pin');

    // Remember chooser context so Back returns to Share options in the same box
    shareFlowCtx = {
      lat: ent.lat,
      lng: ent.lng,
      label: ent.name || (entity && entity.name) || 'Pin',
      entity: ent,
      defaultType: typ,
      fromChooser: opts.fromChooser !== false
    };

    // Same box: loading as action buttons (matches Share step layout)
    showSimpleModal('Select Map', '', [
      { label: 'Loading maps…', close: false, onClick: function () {} },
      shareFlowCtx.fromChooser
        ? { label: 'Back', close: false, onClick: function () { renderShareChooserInModal(shareFlowCtx); } }
        : { label: 'Cancel', close: true }
    ], { reuse: true, cardClass: 'rs-select-map-card' });

    var targets;
    try {
      targets = await listAllTargetMaps();
    } catch (eList) {
      console.warn(eList);
      showSimpleModal('Select Map', '', [
        { label: 'Could not load maps', close: false, onClick: function () {} },
        shareFlowCtx.fromChooser
          ? { label: 'Back', close: false, onClick: function () { renderShareChooserInModal(shareFlowCtx); } }
          : { label: 'Close', close: true }
      ], { reuse: true, cardClass: 'rs-select-map-card' });
      return;
    }
    if (!targets.length) {
      showSimpleModal('Select Map', '', [
        { label: 'No other maps yet', close: false, onClick: function () {} },
        shareFlowCtx.fromChooser
          ? { label: 'Back', close: false, onClick: function () { renderShareChooserInModal(shareFlowCtx); } }
          : { label: 'Close', close: true }
      ], { reuse: true, cardClass: 'rs-select-map-card' });
      return;
    }

    // Same box as Share options: map names are the action buttons
    var mapButtons = targets.map(function (t) {
      return {
        label: t.name || 'Map',
        close: false,
        onClick: function () {
          return copyEntityToMap(ent, typ, t).then(function () {
            closeSimpleModal();
            try {
              if (window.showAppCopyToast) {
                showAppCopyToast('<span class="act">Shared to map</span><br>' + esc(t.name));
              } else {
                alert('Saved to: ' + t.name);
              }
            } catch (eT) {
              alert('Saved to: ' + t.name);
            }
          });
        }
      };
    });
    mapButtons.push(
      shareFlowCtx.fromChooser
        ? { label: 'Back', close: false, onClick: function () { renderShareChooserInModal(shareFlowCtx); } }
        : { label: 'Cancel', close: true }
    );

    showSimpleModal('Select Map', '', mapButtons, {
      reuse: true,
      cardClass: 'rs-select-map-card'
    });
  }

  function openShareLocationChooser(lat, lng, label, entity, defaultType) {
    var ent = entity || { lat: lat, lng: lng, name: label || 'Spot' };
    if (ent.lat == null && lat != null) ent.lat = lat;
    if (ent.lng == null && lng != null) ent.lng = lng;
    if (!ent.name && label) ent.name = label;
    // Prefer in-map Leaflet popup (same window as pin/dot/shape menu)
    if (typeof window.beginShareInMapPopup === 'function') {
      var host = 'layer';
      try {
        if (ent.isCustomArea || defaultType === 'area') host = 'shape';
        else if (ent.isPin || defaultType === 'pin') host = 'pin';
      } catch (eH) {}
      window.beginShareInMapPopup({
        lat: lat != null ? lat : ent.lat,
        lng: lng != null ? lng : ent.lng,
        label: label || ent.name || 'This spot',
        entity: ent,
        defaultType: defaultType || inferShareType(ent, 'pin'),
        host: host
      });
      if (typeof window.setOpenMapPopupHtml === 'function' && typeof window.buildShareChooserPopupHtml === 'function') {
        window.setOpenMapPopupHtml(window.buildShareChooserPopupHtml(label || ent.name || 'Location', {}));
      } else if (typeof window.sharePopupShowChooser === 'function') {
        window.sharePopupShowChooser();
      }
      return;
    }
    shareFlowCtx = {
      lat: lat != null ? lat : ent.lat,
      lng: lng != null ? lng : ent.lng,
      label: label || ent.name || 'This spot',
      entity: ent,
      defaultType: defaultType || inferShareType(ent, 'pin'),
      fromChooser: true
    };
    renderShareChooserInModal(shareFlowCtx);
  }

  /** Share a custom area / shape (full clone including ring). */
  function openShareCustomArea(areaId) {
    if (typeof window.shareCustomArea === 'function') {
      return window.shareCustomArea(areaId);
    }
    var area = null;
    try {
      if (typeof locations !== 'undefined' && Array.isArray(locations)) {
        area = locations.find(function (l) {
          return l && l.isCustomArea && String(l.id) === String(areaId);
        }) || null;
      }
    } catch (e0) {}
    if (!area) {
      try {
        var areas = JSON.parse(localStorage.getItem('alabama_hunt_custom_areas_v1') || '[]');
        if (Array.isArray(areas)) {
          area = areas.find(function (a) { return a && String(a.id) === String(areaId); }) || null;
        }
      } catch (e1) {}
    }
    if (!area) {
      alert('Shape not found.');
      return false;
    }
    openShareLocationChooser(area.lat, area.lng, area.name || 'Custom area', area, 'area');
    return false;
  }

  function openShareMyLocationChooser() {
    var lat = (typeof userLat !== 'undefined') ? userLat : null;
    var lng = (typeof userLng !== 'undefined') ? userLng : null;
    function go(la, lo) {
      shareFlowCtx = {
        lat: la,
        lng: lo,
        label: 'My location',
        entity: { lat: la, lng: lo, name: 'My location' },
        defaultType: 'pin',
        fromChooser: true
      };
      // Same modal shell as pin share; include party live share option
      showSimpleModal('Share', '', [
        {
          label: 'Share to another map',
          primary: true,
          close: false,
          onClick: function () {
            openShareToMapFlow({ lat: la, lng: lo, name: 'My location' }, 'pin', { fromChooser: true });
          }
        },
        {
          label: 'Copy location',
          close: true,
          onClick: function () {
            if (typeof shareLocationLink === 'function') shareLocationLink(la, lo, 'My location');
            else if (typeof googleMapsShareUrl === 'function') {
              var u = googleMapsShareUrl(la, lo);
              if (navigator.clipboard) navigator.clipboard.writeText(u);
              else window.prompt('Copy:', u);
            }
          }
        },
        {
          label: sharing ? 'Stop sharing with party' : 'Share with party (live)',
          close: true,
          onClick: function () {
            if (!sharing) startSharing();
            else stopSharing();
          }
        },
        { label: 'Cancel', close: true }
      ], { reuse: true, cardClass: 'rs-select-map-card' });
    }
    if (lat != null && lng != null) go(lat, lng);
    else if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(function (pos) {
        go(pos.coords.latitude, pos.coords.longitude);
      }, function () { alert('Could not get location'); });
    } else alert('Location unavailable');
  }

  // Map-dot share is handled in index.html (same-size popup chooser).
  // Keep openShareToMapFlow / openShareLocationChooser available for pin popups.
  var _origShareSaved = window.shareSavedPinLocation;
  window.shareSavedPinLocation = function (id) {
    var loc = (typeof locations !== 'undefined') ? locations.find(function (l) { return String(l.id) === String(id); }) : null;
    if (!loc) {
      if (_origShareSaved) return _origShareSaved(id);
      return false;
    }
    // Copy location link only (share-to-map uses openShareToMapFlow with full pin)
    if (typeof shareLocationLink === 'function') {
      shareLocationLink(loc.lat, loc.lng, loc.name || 'Pin');
      return false;
    }
    openShareLocationChooser(loc.lat, loc.lng, loc.name || 'Pin', loc);
    return false;
  };

  var _origShareLoc = window.shareLocationLink;
  // keep original for clipboard path

  // Stamp owner on saves
  var _origRsChanged = window.regSlayerMapDataChanged;
  window.regSlayerMapDataChanged = function () {
    try {
      // tag newest pin without owner
      var pins = JSON.parse(localStorage.getItem('alabama_hunt_custom_pins') || '[]');
      var user = window.__rsUser;
      var prof = C.getProfile && C.getProfile();
      var changed = false;
      var stampName = (prof && (prof.display_name || prof.username))
        || (user && user.user_metadata && (user.user_metadata.username || user.user_metadata.display_name))
        || 'Hunter';
      pins.forEach(function (p) {
        if (p && !p.ownerId && user) {
          p.ownerId = user.id;
          p.ownerName = stampName;
          changed = true;
        } else if (p && p.ownerId && !p.ownerName && user && String(p.ownerId) === String(user.id)) {
          p.ownerName = stampName;
          changed = true;
        }
      });
      if (changed) localStorage.setItem('alabama_hunt_custom_pins', JSON.stringify(pins));
      var areas = JSON.parse(localStorage.getItem('alabama_hunt_custom_areas_v1') || '[]');
      var ca = false;
      areas.forEach(function (a) {
        if (a && !a.ownerId && user) {
          a.ownerId = user.id;
          a.ownerName = stampName;
          ca = true;
        }
      });
      if (ca) localStorage.setItem('alabama_hunt_custom_areas_v1', JSON.stringify(areas));
    } catch (e) {}
    if (typeof _origRsChanged === 'function') _origRsChanged();
  };

  // Filter draws by hidden owners
  var _origDrawPins = null;
  function installDrawFilters() {
    if (typeof drawPinsOnMap === 'function' && !drawPinsOnMap._rsWrapped) {
      _origDrawPins = drawPinsOnMap;
      window.drawPinsOnMap = function () {
        var hidden = window.__rsHiddenContentOwners || {};
        var backup;
        if (typeof locations !== 'undefined' && Object.keys(hidden).length) {
          backup = locations.slice();
          // temporarily filter pins for draw — drawPins filters isPin from locations
          // We'll filter inside by monkeypatching locations filter
        }
        var r = _origDrawPins.apply(this, arguments);
        return r;
      };
      // Simpler: patch after draw clears and re-filter layers — skip, use pre-filter on locations isPin
      window.drawPinsOnMap = function () {
        if (!window.map || !window.pinMarkerGroup) return _origDrawPins.apply(this, arguments);
        var hidden = window.__rsHiddenContentOwners || {};
        var user = window.__rsUser;
        pinMarkerGroup.clearLayers();
        if (typeof locations === 'undefined') return;
        locations.filter(function (l) {
          if (!l.isPin) return false;
          if (l.ownerId && hidden[l.ownerId] && (!user || l.ownerId !== user.id)) return false;
          return true;
        }).forEach(function (loc) {
          // reuse original single-pin draw by temporary call is hard — call original logic
        });
        // Fall back to original then remove filtered
        _origDrawPins.apply(this, arguments);
        try {
          pinMarkerGroup.eachLayer(function (layer) {
            // can't easily map — re-run original only
          });
        } catch (e) {}
      };
      // Actually keep original drawPinsOnMap and filter at data level before draw:
      window.drawPinsOnMap = function () {
        var hidden = window.__rsHiddenContentOwners || {};
        var user = window.__rsUser;
        var removed = [];
        if (typeof locations !== 'undefined' && Object.keys(hidden).length) {
          for (var i = locations.length - 1; i >= 0; i--) {
            var l = locations[i];
            if (l && l.isPin && l.ownerId && hidden[l.ownerId] && (!user || l.ownerId !== user.id)) {
              removed.push(locations.splice(i, 1)[0]);
            }
          }
        }
        try {
          return _origDrawPins.apply(this, arguments);
        } finally {
          if (removed.length) {
            removed.forEach(function (x) { locations.push(x); });
          }
        }
      };
      window.drawPinsOnMap._rsWrapped = true;
    }
  }

  // Wire settings UI extras after DOM ready
  function wireExtraSettings() {
    var createPriv = $('set-create-private-btn');
    if (createPriv) createPriv.onclick = function () {
      var name = ($('set-create-private-name') && $('set-create-private-name').value || '').trim();
      if (!name) { alert('Enter a name for your private map'); return; }
      createPrivateMap(name).then(function (m) {
        if ($('set-create-private-name')) $('set-create-private-name').value = '';
        alert('Private map created: ' + m.name);
        refreshMapsUi();
      }).catch(function (e) { alert(e.message || e); });
    };
    var renameCur = $('set-rename-current-btn');
    if (renameCur) renameCur.onclick = function () {
      var vs = C.getViewState && C.getViewState();
      if (!vs) return;
      if (vs.mode === 'shared' && vs.sharedMapId) {
        // Only host can rename; open same flow as gear
        listMySharedForRename(vs.sharedMapId).then(function (card) {
          if (!card) { alert('Map not found'); return; }
          if (!card.is_host) {
            if (typeof window.showCreatorOnlyNotice === 'function') {
              window.showCreatorOnlyNotice(
                'Only the map creator can rename this map. You can leave the map or ask the host to rename it.',
                'Map creator only'
              );
            } else {
              alert('Only the map creator can rename this map.');
            }
            return;
          }
          promptRenameMap(card);
        }).catch(function (e) { alert(e.message || e); });
      } else if (vs.privateMapId) {
        promptRenameMap({
          kind: 'private',
          id: vs.privateMapId,
          name: vs.privateMapName || 'My Map',
          is_host: true
        });
      } else alert('Open a map first');
    };
    var arrowInp = $('set-my-arrow-color');
    if (arrowInp) {
      arrowInp.value = myArrowColor;
      arrowInp.onchange = function () {
        myArrowColor = arrowInp.value || '#e11d1d';
        try { localStorage.setItem(ARROW_KEY, myArrowColor); } catch (e) {}
        // persist profile
        var sb = window.__rsSb;
        var user = window.__rsUser;
        if (sb && user) {
          sb.from('profiles').update({ arrow_color: myArrowColor }).eq('id', user.id).then(function () {});
        }
        // recolor own GPS if possible
        try {
          if (typeof setGpsMarker === 'function' && typeof userLat !== 'undefined' && userLat != null) {
            // patch buildGpsMarkerIcon via CSS variable
            document.documentElement.style.setProperty('--gps-arrow-color', myArrowColor);
            setGpsMarker(userLat, userLng);
          }
        } catch (e2) {}
      };
      document.documentElement.style.setProperty('--gps-arrow-color', myArrowColor);
    }
    var shareBtn = $('share-loc-btn');
    if (shareBtn) {
      // Toolbar: party live location only — on/off, pulse when active, no multi-option popup
      shareBtn.onclick = function (ev) {
        if (ev) { try { ev.preventDefault(); ev.stopPropagation(); } catch (e0) {} }
        toggleSharing();
        return false;
      };
    }
    // gps long-press / secondary: after snap offer share? User asked: when clicking current location arrow icon on map
    // Own GPS marker is non-interactive. Make share via toolbar. Also hook snapToGPS secondary menu:
  }

  // Patch buildGpsMarkerIcon: own color + optional custom directional icon
  var _origBuildGps = null;
  function installGpsColor() {
    if (typeof buildGpsMarkerIcon === 'function' && !buildGpsMarkerIcon._rsColor) {
      _origBuildGps = buildGpsMarkerIcon;
      window.buildGpsMarkerIcon = function (headingDeg) {
        // Custom direction icon for self
        if (myDirIconId && getDirIconById(myDirIconId) && typeof L !== 'undefined') {
          var scale = 1.5;
          try {
            if (typeof getGpsMarkerScale === 'function') scale = getGpsMarkerScale();
          } catch (eS) {}
          // User size preference multiplies GPS zoom scale
          var userSc = myDirIconScale || 1;
          // Slightly larger than default arrow (~17×24 * scale)
          var s = Math.round(28 * scale * userSc);
          var rot = 0;
          if (headingDeg != null && !isNaN(headingDeg)) {
            rot = ((Number(headingDeg) % 360) + 360) % 360;
          }
          /*
           * Same rotation model as the default triangle:
           *  - Outer .gps-heading-tri-wrap rotates by device heading (compass line uses same heading)
           *  - Inner glyph is nose-UP in wrap space (heading=0 → cssRot = −frontDeg)
           * Never put live heading on BOTH layers — that double-rotated and drifted off the line.
           */
          var body = buildDirBodyHtml(myArrowColor, 0, myDirIconId, s);
          var html =
            '<div class="gps-heading-tri-wrap rs-dir-gps-wrap" data-rs-gps-rot="1" style="width:' + s +
              'px;height:' + s + 'px;position:relative;overflow:visible;' +
              'transform:rotate(' + rot.toFixed(1) + 'deg);transform-origin:center center;will-change:transform;">' +
              body +
            '</div>';
          return L.divIcon({
            className: 'gps-heading-icon',
            html: html,
            iconSize: [s, s],
            iconAnchor: [s / 2, s / 2]
          });
        }
        var icon = _origBuildGps(headingDeg);
        try {
          if (icon && icon.options && icon.options.html) {
            icon.options.html = icon.options.html.replace(/#e11d1d/g, myArrowColor).replace(/#ff4d4d/g, myArrowColor);
            var usc = myDirIconScale || 1;
            if (usc !== 1 && Math.abs(usc - 1) > 0.02) {
              icon.options.html =
                '<div style="transform:scale(' + usc.toFixed(2) +
                ');transform-origin:center center;line-height:0;">' + icon.options.html + '</div>';
              if (icon.options.iconSize) {
                icon.options.iconSize = [
                  Math.round(icon.options.iconSize[0] * usc),
                  Math.round(icon.options.iconSize[1] * usc)
                ];
                icon.options.iconAnchor = [
                  Math.round(icon.options.iconSize[0] / 2),
                  Math.round(icon.options.iconSize[1] / 2)
                ];
              }
            }
          }
        } catch (e) {}
        return icon;
      };
      window.buildGpsMarkerIcon._rsColor = true;
    }
  }

  // Capture sb + user from auth client used by main module
  function bindClientRefs() {
    // Prefer auth-sync's single shared client (same session / JWT)
    try {
      var c = getSb();
      if (c) window.__rsSb = c;
    } catch (e0) {}
    if (!window.__rsSb && window.supabase && window.supabase.createClient) {
      try {
        var url = 'https://grvhmktqzrivbqbczkii.supabase.co';
        var key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdydmhta3RxenJpdmJxYmN6a2lpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU3MDQ0MTIsImV4cCI6MjEwMTI4MDQxMn0.fFfrS-7w45IzxwOvvyYDB5ngLnyTz-Ru7XVL5LZXm4o';
        window.__rsSb = window.supabase.createClient(url, key, {
          auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage }
        });
      } catch (e) {}
    }
    var sb = getSb();
    if (sb) {
      window.__rsSb = sb;
      sb.auth.getSession().then(function (res) {
        if (res.data && res.data.session) {
          window.__rsUser = res.data.session.user;
          var uid = res.data.session.user.id;
          sb.from('profiles').select('arrow_color, direction_icon_id').eq('id', uid).maybeSingle()
            .then(function (r) {
              if (r.data) {
                if (r.data.arrow_color) {
                  myArrowColor = r.data.arrow_color;
                  try { localStorage.setItem(ARROW_KEY, myArrowColor); } catch (eA) {}
                  try { document.documentElement.style.setProperty('--gps-arrow-color', myArrowColor); } catch (eC) {}
                }
                if (r.data.direction_icon_id) {
                  myDirIconId = r.data.direction_icon_id;
                  try { localStorage.setItem(DIR_ICON_KEY, myDirIconId); } catch (eD) {}
                } else {
                  myDirIconId = null;
                  try { localStorage.removeItem(DIR_ICON_KEY); } catch (eD2) {}
                }
                try { syncMyDirIconSettingsBtn(); } catch (eB) {}
                try {
                  if (typeof setGpsMarker === 'function' && typeof userLat !== 'undefined' && userLat != null) {
                    setGpsMarker(userLat, userLng);
                  }
                } catch (eG) {}
              }
            }).catch(function () {});
        }
      }).catch(function () {});
    }
  }

  // Hook maps tab refresh
  window.addEventListener('regslayer-maps-tab', function () {
    refreshMapsUi();
  });

  // After auth
  function restartPartyPullLoop() {
    if (partyPullInterval) {
      try { clearInterval(partyPullInterval); } catch (eC) {}
      partyPullInterval = null;
    }
    // Shared map only; never private maps. Realtime is primary; poll is backup.
    partyPullInterval = setInterval(function () {
      var vs = C.getViewState && C.getViewState();
      if (vs && vs.mode === 'shared' && vs.sharedMapId && document.visibilityState === 'visible') {
        var m = getMap();
        if (m && !window.map) {
          try { window.map = m; } catch (e) {}
        }
        pullPresence({ skipMembers: true });
      }
    }, peerPullIntervalMs());
  }

  function ensurePartyPullLoop() {
    if (partyPullInterval) return;
    restartPartyPullLoop();
    // Re-tune poll rate occasionally as party size changes
    setInterval(function () {
      try {
        if (partyPullInterval && currentSharedMapId()) restartPartyPullLoop();
      } catch (eR) {}
    }, 60000);
    // Extra pull when tab becomes visible (mobile backgrounding)
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        setTimeout(function () {
          try { ensurePresenceRealtimeForCurrentMap(); } catch (eRt) {}
          pullPresence({ force: true });
          try { markMapViewed(); } catch (eMv) {}
        }, 200);
      }
    });
    // pageshow (bfcache restore on iOS)
    window.addEventListener('pageshow', function () {
      setTimeout(function () {
        try { ensurePresenceRealtimeForCurrentMap(); } catch (eRt2) {}
        pullPresence({ force: true });
        try { markMapViewed(); } catch (eMv2) {}
      }, 300);
    });
  }

  function onReady() {
    bindClientRefs();
    wireExtraSettings();
    installGpsColor();
    installDrawFilters();
    wireShareMapViewTracking();
    // Restore share preference (toggle stays on in background after idle pause)
    sharing = false;
    shareWanted = false;
    try {
      var pref = readSharePref();
      if (pref && (pref.want || pref.on)) {
        shareWanted = true;
        if (pref.started) shareStartedAt = Number(pref.started) || Date.now();
        if (pref.lastView) lastMapViewAt = Number(pref.lastView) || Date.now();
        // Prefer stale lastView for idle calc until user opens the map
      }
    } catch (ePref) {}
    updateShareLocBtn();
    ensurePartyPullLoop();
    try { ensurePresenceRealtimeForCurrentMap(); } catch (eRt0) {}
    // Warm map-name dropdown so first click is smooth
    try {
      setTimeout(function () { prefetchMapSwitcherLists(); }, 800);
    } catch (ePf) {}
    setTimeout(function () {
      // Capture map if already created
      try {
        var m0 = getMap();
        if (m0) window.map = m0;
      } catch (e0) {}
      refreshMapsUi();
      try { ensurePresenceRealtimeForCurrentMap(); } catch (eRt1) {}
      pullPresence({ force: true });
      // Opening the app / map counts as a view → reset idle + resume if toggle still on
      try { markMapViewed(); } catch (eMv) {}
    }, 500);
    // Retry after map typically mounts
    [1200, 2500, 5000].forEach(function (ms) {
      setTimeout(function () {
        try {
          var m = getMap();
          if (m) {
            window.map = m;
            hookMapForShareView(m);
          }
        } catch (e1) {}
        pullPresence();
      }, ms);
    });
  }

  // When main app finishes ensureMap, re-pull party markers + track map view
  function installEnsureMapPartyHook() {
    var _origEnsureMap = window.ensureMap;
    if (typeof _origEnsureMap !== 'function' || _origEnsureMap._rsPartyHook) return;
    window.ensureMap = function () {
      return _origEnsureMap.apply(this, arguments).then(function (m) {
        try {
          if (m) window.map = m;
          else if (getMap()) window.map = getMap();
        } catch (e) {}
        try { hookMapForShareView(m || getMap()); } catch (eH) {}
        setTimeout(function () {
          try { ensurePresenceRealtimeForCurrentMap(); } catch (eRt) {}
          pullPresence({ force: true });
          try { markMapViewed(); } catch (eMv) {}
        }, 50);
        return m;
      });
    };
    window.ensureMap._rsPartyHook = true;
  }
  installEnsureMapPartyHook();
  // ensureMap is defined later in index.html — retry until wired
  [0, 500, 1500, 4000].forEach(function (ms) {
    setTimeout(installEnsureMapPartyHook, ms);
  });

  // After cloud map switch, re-bind presence Realtime so dots appear without refresh
  function installSwitchSharedHook() {
    if (!C.switchToShared || C.switchToShared._rsPresenceHook) return;
    var _orig = C.switchToShared.bind(C);
    C.switchToShared = function () {
      var args = arguments;
      return Promise.resolve(_orig.apply(C, args)).then(function (r) {
        try { ensurePresenceRealtimeForCurrentMap(); } catch (eRt) {}
        try { restartPartyPullLoop(); } catch (ePl) {}
        setTimeout(function () {
          try { pullPresence({ force: true }); } catch (eP) {}
        }, 80);
        return r;
      });
    };
    C.switchToShared._rsPresenceHook = true;
  }
  [0, 800, 2000, 5000].forEach(function (ms) {
    setTimeout(installSwitchSharedHook, ms);
  });

  if (C.authReady && C.authReady.then) {
    C.authReady.then(onReady).catch(onReady);
  } else {
    setTimeout(onReady, 1200);
  }

  // Public API
  window.RegSlayerParty = {
    refreshMapsUi: refreshMapsUi,
    updateBrandName: updateBrandName,
    currentMapDisplayName: currentMapDisplayName,
    toggleSharing: toggleSharing,
    startSharing: startSharing,
    stopSharing: stopSharing,
    openShareToMapFlow: openShareToMapFlow,
    openShareLocationChooser: openShareLocationChooser,
    openShareMyLocationChooser: openShareMyLocationChooser,
    openShareCustomArea: openShareCustomArea,
    listAllTargetMaps: listAllTargetMaps,
    openEditOwnMarker: window.openEditOwnMarker,
    openMapSwitcher: openMapSwitcher,
    closeMapSwitcher: closeMapSwitcher,
    listPrivateMaps: listPrivateMaps,
    createPrivateMap: createPrivateMap,
    switchToPrivate: switchToPrivate,
    isSharing: function () { return sharing; },
    isShareWanted: function () { return shareWanted; },
    markMapViewed: markMapViewed,
    stampOwner: stampOwner,
    pullPresence: pullPresence,
    onDeviceHeading: onDeviceHeading,
    copyEntityToMap: copyEntityToMap,
    recordMapVisit: recordMapVisit,
    recordVisitFromViewState: recordVisitFromViewState
  };

  // Multi-map on create pin: inject checkboxes after save forms appear — hook savePinFromMap
  var _origSavePin = null;
  function waitForSavePin() {
    if (typeof savePinFromMap === 'function' && !savePinFromMap._rsMulti) {
      _origSavePin = savePinFromMap;
      window.savePinFromMap = function () {
        var r = _origSavePin.apply(this, arguments);
        // After save, offer multi-map if checked
        setTimeout(function () {
          var boxes = document.querySelectorAll('.rs-extra-map-chk:checked');
          if (!boxes.length) return;
          try {
            var pins = JSON.parse(localStorage.getItem('alabama_hunt_custom_pins') || '[]');
            var last = pins[pins.length - 1];
            if (!last) return;
            boxes.forEach(function (chk) {
              var kind = chk.getAttribute('data-kind');
              var id = chk.getAttribute('data-id');
              copyEntityToMap(last, 'pin', { kind: kind, id: id }).catch(function (e) { console.warn(e); });
            });
          } catch (e) {}
        }, 100);
        return r;
      };
      savePinFromMap._rsMulti = true;
    }
  }
  setInterval(waitForSavePin, 2000);

  // Pin form multi-map targets
  window.rsFillExtraMapChecks = async function (containerId) {
    var el = $(containerId);
    if (!el) return;
    el.innerHTML = '<span class="settings-hint">Also save to:</span>';
    try {
      var maps = await listAllTargetMaps();
      maps.forEach(function (m) {
        var lab = document.createElement('label');
        lab.className = 'settings-row';
        lab.innerHTML = '<input type="checkbox" class="rs-extra-map-chk" data-kind="' + m.kind + '" data-id="' + m.id + '"><span class="sr-text">' + esc(m.name) + '</span>';
        el.appendChild(lab);
      });
    } catch (e) {}
  };
})();

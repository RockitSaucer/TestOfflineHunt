# WMA internal permit zones (Zone A/B) — how we got here

**Purpose:** Retain the rules and pipeline so the next agent (or multi-state work) does not re-discover this the hard way.

**Product terms (do not mix):**

| Term | Meaning | Used for |
|------|---------|----------|
| **Deer zone A–E** | Statewide Alabama deer season / peak-rut zones | Peak rut line, statewide private-land calendar |
| **WMA zone A/B** | **Permit-map** zones *inside* one WMA (AREA PDF) | Gun dates that differ by zone, list labels, green ✓ |

Always label UI as **“(Zone B)”** on the unit name when relevant. Never call WMA zones “deer zones.”

---

## User rules we learned (must follow)

1. **List naming**
   - If **only some** WMA zones are open for the selected **date + weapon** →  
     `Unit Official Name (Zone B)`  
   - If **every** digitized WMA zone of that unit is open →  
     plain unit name (no zone suffix).

2. **Map green ✓ (Available tracts)**
   - Pin sits on **that zone’s centroid** (from zone rings), **never** the whole WMA GIS outline.
   - One check per list row id (`wma_z_…_B`).

3. **Map click / popup**
   - Clicking a WMA zone acts like clicking a WMA: orange free-dot + same menu flow.
   - Status title: **Can / Can’t hunt that day with {weapon}**.
   - Directly under title: **Can hunt with: …** (weapons that open this unit/zone).
   - Name includes zone: `James D. Martin - Skyline Wildlife Management Area (Zone B)`.
   - **No parcel / owner block** on that status popup.
   - If the unit uses **its own AREA/permit calendar** (profile, NWR, or has WMA zones), **do not** show statewide deer-zone / peak-rut lines.

4. **Weapon matching**
   - **Rifle (Gun) ≠ Primitive.** Do not treat modern rifle as open on muzzleloader-only days.
   - Align `weaponMatchesSeason` with `ruleWeaponMatchesFilter`.

5. **Data must work offline / `file://`**
   - Zone rings live in **`wma-zones-data.js`** as `window.EMBEDDED_WMA_ZONES`.
   - Do **not** rely only on `fetch('data/….geojson')` for local opens.

6. **GIS whole-unit polygons**
   - ADCNR WMA layer is usually **one polygon per WMA** — **no** official A/B GIS fields.
   - After `syncPublicLandsToLocations`, **re-inject** zone rows; skip whole-unit GIS list rows when zone geometry exists for that name.

---

## Architecture (Alabama production — `_push_hunt_slayer/`)

| Piece | Role |
|-------|------|
| `wma-zones-data.js` | Embedded compact rings + unitMatch + lat/lng per zone |
| `registerWmaZoneRecord` / `wmaZoneFeatures[]` | Runtime zone index |
| `queryOpenMultiZoneWmaSeasons` | **Authoritative** Available-tracts rows for multi-zone WMAs |
| `queryOpenSeasons` | Calls multi-zone first; skips whole-unit GIS for those names |
| `collapseMultiZoneListMatches` | Pass-through for `wma_z_` / `wma_all_` ids; deer-zone GIS path separate |
| `resolveListedHuntPinLatLng` | Zone letter → zone ring centroid for green ✓ |
| `UNIT_DEER_PROFILES[].seasons[].wmaZones` | Optional `['A']` / `['B']` / `['A','B']` on each season |
| `drawWmaZoneOverlays` | Green/tan fills when WMA layer is on |
| `lookupWmaAreaMapPdf` / `WMA_AREA_MAP_PDFS` | Official OA 2026–27 AREA PDF per unit |
| `tools/digitize_wma_zones.py` | Re-digitize from OA PDFs + ADCNR boundary clip |

**List evaluation order (do not reverse):**

1. Ensure `EMBEDDED_WMA_ZONES` → `wmaZoneFeatures`.
2. `queryOpenMultiZoneWmaSeasons` → open zone rows (or one combined `listCoversAllZones` row).
3. Other locations, **excluding** units already covered by multi-zone geometry.
4. Collapse (mostly pass-through for `wma_z_` ids).
5. Render name + optional `(Zone X)` + weapons tags.
6. `drawListedHuntCheckmarks` using zone-aware `resolveListedHuntPinLatLng`.

---

## How we built zone geometry (repeat for a new state)

1. Download official **AREA / permit map PDFs** (Outdoor Alabama style: map page + seasons page).
2. Identify units with **ZONE A / ZONE B** legend (green vs tan on OA maps).
3. Query state GIS for the **official unit boundary** (AL: ADCNR `WildlifeManagementAreas` MapServer).
4. Rasterize map page → color-sample green (A) / tan (B) → georef roughly with boundary bbox → **clip to GIS boundary**.
5. Simplify rings; export compact JSON → `window.EMBEDDED_WMA_ZONES=…` in `wma-zones-data.js`.
6. Wire seasons: for each unit with different gun calendars, set `seasons[].wmaZones`.
7. SW: add `wma-zones-data.js` to shell precache; bump `SHELL_CACHE`.

**Script (this repo):**  
`Desktop/HuntApp/_push_hunt_slayer/tools/digitize_wma_zones.py`  
Research/scratch PDFs can live under `_wma_research/` (optional; not required on production deploy).

**Alabama units digitized (2026–27):** Black Warrior, Skyline, Freedom Hills, Lauderdale, Hollins, Choccolocco, Yates Lake, Upper Delta, Barbour.

**Accuracy note:** Digitized fills are a **planning aid** clipped to ADCNR boundaries. Always link official AREA PDF; UI already says confirm official regs.

---

## Multi-state checklist (add TX / GA / etc.)

1. **Rename concept** if needed: “permit unit zones” not “WMA” if the state uses different language.
2. **State pack fields:**
   - `PERMIT_ZONE_FEATURES` (or embed JS file)
   - Season tables with optional `permitZones: ['A','B']`
   - Official map PDF table
   - GIS whole-unit endpoint (for outline paint)
3. **Reuse engines:** list expand, checkmark resolve, click status banner, weapon-strict matching.
4. **Storage keys:** keep state prefix (`al_`, `tx_`, …) so maps don’t collide.
5. **Do not** reuse Alabama deer-zone A–E polygons for other states’ unit-internal zones.

---

## Session arc that led here (2026-08)

- GPS double prompt → single boot geolocation.
- Multi-zone list/map mixed with deer zones → split terminology + UI.
- Black Warrior Nov 19 gun = Zone B only from OA PDF.
- `fetch` geojson failed on local file → embed rings.
- GIS sync wiped zone list rows → re-inject + **authoritative** `queryOpenMultiZoneWmaSeasons`.
- Green ✓ on whole WMA → force zone centroid path.
- Popup: weapon-aware can/can’t + “Can hunt with:”; hide deer zone on unit-specific rules; strip parcel info.
- Settings: map click-dot color/size.

---

## Ship / files that must stay together

```
_push_hunt_slayer/
  index.html
  wma-zones-data.js          ← required next to index
  sw.js                      ← must precache wma-zones-data.js
  tools/digitize_wma_zones.py
  data/wma_zones_all_compact.json  ← optional rebuild source
```

Open production via multi-file shell (Start Hunt App / `_push_hunt_slayer/index.html`), not a lone copied HTML without `wma-zones-data.js`.

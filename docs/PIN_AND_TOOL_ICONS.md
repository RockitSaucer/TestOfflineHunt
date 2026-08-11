# Pin & tool icon pipeline (REG SLAYER / TestOffline)

**Do not reinvent this.** When the user asks for new pins (or tool icons) for the hunt app / TestOffline / REG SLAYER, follow this document exactly so results match the current map pins and toolbar tools.

---

## Custom map pins

### Goal (visual rules — locked)

1. **Source art** is isolated from any background (white, paper, checkerboard, soft gray fringe).
2. Output is a **transparent PNG** glyph only — **no pin-in-pin**, no nested black pin frame, no white box.
3. Glyph sits **in the middle of the map pin**, **edge-to-edge** inside the white disc (may touch the disc edge).
4. **Display name** = photo / file name (human-readable: `Dead Head`, `Beaver Dam`).
5. **Default pin body color** = dominant color of the isolated image  
   - Near-black silhouettes → `#1a1a1a`  
   - Colored art (e.g. blood) → sampled color (e.g. `#e43844`)
6. **Default disc (inner) color** = **`#ffffff`** (white).
7. **Default icon tint** = **`natural`** (PNG colors as-is; no recolor filter).
8. **Inner disc and icon color must never match** (app enforces this on pickers + save).
9. Picker grid: **white tiles**, natural glyphs, **name only on hover**.

### Source folder

```
C:\Users\Rockit\Desktop\HuntApp\button icons\Layers naked\
```

- Drop new images here (JPG/PNG).
- Prefer flat silhouettes or simple art on white/transparent backgrounds.
- File name becomes the pin name (stem only).

### Output folder

```
Desktop/TestOffline/icons/pins/
```

- One file per pin: `{slug}.png` (128×128 RGBA).
- Catalog snapshot: `icons/pins/_catalog.json` (id, name, src, defaultColor).

### Id / slug rules

| Source file        | id / file              | name (display) |
|--------------------|------------------------|----------------|
| `Buck.JPG`         | `buck.png`             | Buck           |
| `Beaver Dam.JPG`   | `beaver_dam.png`       | Beaver Dam     |
| `Dead Head.JPG`    | `deadhead.png`         | Dead Head      |
| `Bow Stand.JPG`    | `bow_stand.png`        | Bow Stand      |

- Lowercase, spaces → `_`, strip non-alphanumerics.
- Special case already in the script: `dead_head` → `deadhead`.

### Build command

From any cwd (Python 3 + Pillow required):

```bash
python Desktop/TestOffline/tools/process_pin_icons.py
```

Script path: `Desktop/TestOffline/tools/process_pin_icons.py`

**Pipeline (do not skip steps):**

1. Load RGBA.
2. **Edge flood-fill** — clear connected light/white background from borders.
3. **Global light pass** — remove leftover white / low-sat pale gray.
4. **Harden silhouettes** — monochrome black art: force solid black + clean alpha; leave saturated color art alone (blood).
5. Second flood-fill + **tight alpha crop**.
6. **Fit square 128×128** with tiny padding (~2%) so glyph can fill the pin disc.
7. **Dominant color** → `defaultColor` (black silhouettes force `#1a1a1a`).
8. Write PNG + update `_catalog.json`.

If a specific icon still shows a white fringe after the batch run, re-tune thresholds in that script for that asset only, or re-run after cleaning the source file.

### Wire into the app (`index.html`)

After processing, update **`PIN_ICON_CATALOG`** in `Desktop/TestOffline/index.html`:

```js
{ id: 'new_slug', name: 'Display Name', src: 'icons/pins/new_slug.png', defaultColor: '#1a1a1a' },
```

Copy `defaultColor` from `_catalog.json`. Keep the array sorted by `name` (existing `.sort(...)` is fine).

**Render helpers (already implemented — keep behavior):**

| Piece | Behavior |
|-------|----------|
| `pinIconImageSrc` | `icons/pins/{id}.png` + cache-bust query (`v=…`) when assets change |
| `pinIconMarkup` | Natural PNG by default; optional CSS recolor only if user picks a tint |
| `buildCustomPinMarkerHtml` | Teardrop body = `color` / `defaultColor`; **white disc**; glyph fills disc |
| `selectPinIcon` | Fresh pick → outer = `defaultColor`, inner = `#ffffff`, glyph = `natural` |
| `applyPinInnerIconDistinct` | Never allow disc hex === icon hex |

**Cache:** bump `SHELL_CACHE` in `sw.js` when shipping new pin PNGs so clients fetch them.

### Map pin chrome (locked sizes)

- Body ~38px rotated teardrop, white outer stroke.
- Inner disc ~30px, **white** default, glyph ~100% of disc (`object-fit: contain`).
- No nested pin artwork inside the disc.

### Adding many new pins (checklist)

1. Add source files to `HuntApp\button icons\Layers naked\`.
2. Run `python tools/process_pin_icons.py` from TestOffline (or full path).
3. Merge new entries into `PIN_ICON_CATALOG` from `_catalog.json`.
4. Spot-check a few PNGs (no white box; blood stays red).
5. Bump SW shell cache; commit `icons/pins/*`, `index.html`, `sw.js`.

---

## Toolbar tool icons

### Goal

- Same isolation idea as pins (transparent glyph, no white box).
- Toolbar **chrome matches** compass / GPS / settings (dark fill, muted border, equal height).
- Icons differ only by glyph + color tint:
  - **Measure** — yellow  
  - **Draw** — yellow  
  - **Track** — red (pulses when tracking)  
  - **Layers** — light/white on dark chrome; **slightly larger**; **thicker strokes** (extra dilation step)

### Source folder

```
C:\Users\Rockit\Desktop\HuntApp\button icons\Tool Icons\
```

| Source            | Output                    |
|-------------------|---------------------------|
| `Measure.jpg`     | `icons/tools/measure.png` |
| `Draw Shape.jpg`  | `icons/tools/draw.png`    |
| `Track.jpg`       | `icons/tools/track.png`   |
| `Layers.jpg`      | `icons/tools/layers.png`  |

### Build command

```bash
python Desktop/TestOffline/tools/process_tool_icons.py
```

For **layers** thicker lines: after processing (or as a follow-up), dilate alpha (MaxFilter) so strokes read bolder — already applied once; re-apply if reprocessing layers from source.

### CSS (index.html)

- Shared button classes: `.mdt-btn.mdt-icon-btn`, `.map-layers-toggle-btn` — same chrome as `.mbb-compass-btn` family.
- Color via `filter` on `.mdt-icon-img` (yellow measure/draw, red track, invert white layers).
- Layers size ~72% of button / 28px desktop, slightly larger than other tools.

---

## Related paths

| Role | Path |
|------|------|
| Pin processor | `Desktop/TestOffline/tools/process_pin_icons.py` |
| Tool processor | `Desktop/TestOffline/tools/process_tool_icons.py` |
| Pin assets | `Desktop/TestOffline/icons/pins/` |
| Tool assets | `Desktop/TestOffline/icons/tools/` |
| Catalog JSON | `Desktop/TestOffline/icons/pins/_catalog.json` |
| App wiring | `Desktop/TestOffline/index.html` (`PIN_ICON_CATALOG`, marker HTML, pickers) |
| SW cache | `Desktop/TestOffline/sw.js` (`SHELL_CACHE`) |
| Source pins | `Desktop/HuntApp/button icons/Layers naked/` |
| Source tools | `Desktop/HuntApp/button icons/Tool Icons/` |

---

## Agent prompt shorthand

If the user says **“add pins”**, **“new pin icons”**, **“more pins like the others”**, or points at new art for the hunt app:

1. Read **this file**.
2. Put sources in **Layers naked** (or the path they give).
3. Run **`process_pin_icons.py`**.
4. Update **`PIN_ICON_CATALOG`** + bump **SW cache**.
5. Do **not** wrap glyphs in extra pin art or leave white backgrounds.
6. Defaults: **white disc**, **natural glyph**, **body = image color**.

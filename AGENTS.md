# TestOfflineHunt — agent notes

**Purpose:** Safe merge lab for PlanSlayer event/list UX on Hunt map shell.  
**GitHub:** `RockitSaucer/TestOfflineHunt`  
**Do not** push changes from here into Hunt-Slayer / Reg-Slayer / PlanSlayer until Rockit says promote.

## Version

`APP_VERSION` in `index.html` · shell `test-offline-hunt-shell-vN` in `sw.js`

## Layout

| Path | Role |
|------|------|
| `index.html` | Hunt shell (from 7.0.60) + Plan kit hook in `updateEventsList` |
| `plan-kit/plan-ui.css` | Plan event cards + float window styles |
| `plan-kit/plan-events-lists.js` | `PlanEventsListsKit` — cards, List float, triad, Got it/Drop |
| `api/report-issue.js` | Issues → **TestOfflineHunt** (`from-site`, `from-testofflinehunt`) |
| `calendar-events.js` | Hunt calendar store (unchanged keys) |

## User requirements (product)

1. Calendar **dropdown events list** looks/acts like PlanSlayer cards.  
2. Event detail: **T minus** + **List** under it.  
3. List = large floating window (map still visible around it), full list options.  
4. Close = minimize back to List button.  
5. Same options as PlanSlayer lists; prefer better function on conflicts.  
6. Fixes via Report issue → this repo while Rockit is at work.

## Conflict policy (three apps)

When Hunt vs Plan disagree, pick **better function** (Plan list UX for lists/events; Hunt for map/regs). Keep storage keys stable so the three apps share data in one browser.

## Ship patch here

1. Edit kit and/or index hook.  
2. Bump `APP_VERSION` + `SHELL_CACHE`.  
3. `Changes_….txt` note.  
4. Commit + push **TestOfflineHunt only**.

## Promote

Only after Rockit reviews on this repo / preview.

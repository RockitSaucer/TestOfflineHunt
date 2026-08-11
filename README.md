# TestOfflineHunt

**Merge lab:** Hunt Slayer map shell + PlanSlayer event cards & floating lists.

Not production. Production remains:

- [Hunt-Slayer](https://github.com/RockitSaucer/Hunt-Slayer) → huntslayer.com  
- [PlanSlayer](https://github.com/RockitSaucer/PlanSlayer) → planslayer.com  

## What this is

1. **Calendar day events** use PlanSlayer-style cards (name, T minus, Edit event).
2. Expand an event → **T minus** block + **List** button (second control under countdown).
3. **List** opens a large floating window (not full-map takeover) with Plan packing lists:
   - Left: Personal lists + Event lists from PlanSlayer storage  
   - Right: To do / To buy / To bring triad  
   - Got it! / Drop, expand options (title, qty, priority, note, highlight), add items  
4. Close (×) **minimizes** the float back to the List button.
5. **Report an issue** posts to **this** repo (`from-site` + `from-testofflinehunt`).

## Version

`APP_VERSION = 7.0.61-testoffline`  
Shell cache: `test-offline-hunt-shell-v1`

## Shared storage (same browser profile)

| Key | Role |
|-----|------|
| `reg_slayer_cal_events_v2` | Hunt calendar events |
| `plan_slayer_free_lists_v1` | Plan named lists |
| `slayer_event_lists_v1` | Hunt↔Plan list bridge |

Lists created in PlanSlayer appear here when you open **List** on a matching event (or in the float nav).

## Local run

```bash
cd Desktop/TestOfflineHunt
npx serve .
```

Open the URL (not `file://`). Hard-refresh after SW updates.

## Report → fix loop (work)

1. Use **Report an issue** in the TestOfflineHunt header (or describe bugs clearly).  
2. Issues land on **RockitSaucer/TestOfflineHunt** with `from-testofflinehunt`.  
3. Agent fixes **this** repo only.  
4. **Do not** push to Hunt-Slayer until you approve the merge.

## Promote to Hunt production later

After sign-off:

1. Port `plan-kit/` into `_push_hunt_slayer/`.  
2. Keep the `updateEventsList` Plan kit hook.  
3. Point report-issue back to Hunt-Slayer labels.  
4. Bump Hunt `APP_VERSION` + shell cache.

## Kit sources

- Events/lists UX: `Desktop/PlanSlayer` (skills: make-lists, plan-events)  
- Map/calendar host: Hunt `_push_hunt_slayer`  
- Kit files: `plan-kit/plan-ui.css`, `plan-kit/plan-events-lists.js`

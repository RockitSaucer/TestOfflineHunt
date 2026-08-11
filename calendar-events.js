/**
 * Hunt / Reg Slayer — multi-day map calendar events
 * localStorage first; optional Supabase when map_calendar_events exists.
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'reg_slayer_cal_events_v2';
  var HIDES_KEY = 'reg_slayer_cal_event_hides_v1';
  var events = [];
  var localHides = {}; // eventId -> true
  var pendingLocationPick = null; // { draftId|eventId, name }
  var ready = false;

  function uid() {
    return 'cev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function localYmd(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function parseYmd(s) {
    if (!s) return null;
    var p = String(s).split('-');
    if (p.length < 3) return null;
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return isNaN(d.getTime()) ? null : d;
  }

  function loadLocal() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      events = Array.isArray(raw) ? raw.map(normalize).filter(Boolean) : [];
    } catch (e) {
      events = [];
    }
    try {
      localHides = JSON.parse(localStorage.getItem(HIDES_KEY) || '{}') || {};
    } catch (e2) {
      localHides = {};
    }
  }

  function saveLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
      localStorage.setItem(HIDES_KEY, JSON.stringify(localHides));
    } catch (e) {}
  }

  function normalize(ev) {
    if (!ev || typeof ev !== 'object') return null;
    var start = ev.startDate || ev.start_date || ev.date || null;
    var end = ev.endDate || ev.end_date || start;
    if (!start) return null;
    if (!end || end < start) end = start;
    var hl = ev.hunt_link || ev.huntLink || null;
    var listPack = ev.listPack || ev.list_pack || (hl && hl.listPack) || null;
    return {
      id: String(ev.id || uid()),
      text: String(ev.text || ev.name || ev.title || 'Event'),
      color: ev.color || '#e59a18',
      startDate: start,
      endDate: end,
      mapScope: ev.mapScope || ev.map_scope || 'personal', // personal | all | shared | private
      sharedMapId: ev.sharedMapId || ev.shared_map_id || null,
      privateMapId: ev.privateMapId || ev.private_map_id || null,
      mapIds: Array.isArray(ev.mapIds) ? ev.mapIds : (Array.isArray(ev.map_ids) ? ev.map_ids : []),
      lat: ev.lat != null ? Number(ev.lat) : null,
      lng: ev.lng != null ? Number(ev.lng) : null,
      locationLabel: ev.locationLabel || ev.location_label || null,
      locationId: ev.locationId != null ? ev.locationId : null,
      weapon: ev.weapon || null,
      land: ev.land || null,
      creatorUserId: ev.creatorUserId || ev.creator_user_id || null,
      createdAt: ev.createdAt || ev.created_at || new Date().toISOString(),
      updatedAt: ev.updatedAt || ev.updated_at || new Date().toISOString(),
      planEventId: ev.planEventId || ev.plan_event_id || (hl && hl.planEventId) || null,
      planListId: ev.planListId || ev.plan_list_id || (hl && hl.planListId) || null,
      inviteCode: ev.inviteCode || ev.invite_code || (hl && hl.inviteCode) || null,
      members: Array.isArray(ev.members) ? ev.members : (hl && Array.isArray(hl.members) ? hl.members : []),
      listPack: listPack,
      _fromPlanSlayer: !!(ev._fromPlanSlayer || (hl && hl.fromPlanSlayer)),
      _localOnly: !!ev._localOnly
    };
  }

  function myId() {
    try {
      if (global.RegSlayerCloud && typeof global.RegSlayerCloud.getUser === 'function') {
        var u = global.RegSlayerCloud.getUser();
        if (u && u.id) return u.id;
      }
      if (global.__rsUser && global.__rsUser.id) return global.__rsUser.id;
    } catch (e) {}
    return null;
  }

  function isHidden(id) {
    return !!localHides[String(id)];
  }

  function hideForMe(id) {
    localHides[String(id)] = true;
    saveLocal();
    // Best-effort cloud hide
    try {
      var sb = global.RegSlayerCloud && global.RegSlayerCloud.getClient && global.RegSlayerCloud.getClient();
      var uid = myId();
      if (sb && uid) {
        sb.from('map_calendar_event_hides').upsert({ event_id: id, user_id: uid }).then(function () {});
      }
    } catch (e) {}
  }

  function unhideForMe(id) {
    delete localHides[String(id)];
    saveLocal();
    // Best-effort cloud unhide
    try {
      var sb = global.RegSlayerCloud && global.RegSlayerCloud.getClient && global.RegSlayerCloud.getClient();
      var uid = myId();
      if (sb && uid) {
        sb.from('map_calendar_event_hides').delete().eq('event_id', id).eq('user_id', uid).then(function () {});
      }
    } catch (e) {}
  }

  function isCreator(ev) {
    if (!ev) return false;
    var me = myId();
    if (!me) return !ev.creatorUserId; // local-only guest owns local events
    if (!ev.creatorUserId) return true;
    return String(ev.creatorUserId) === String(me);
  }

  function activeSharedMapId() {
    try {
      if (global.RegSlayerParty && typeof global.RegSlayerParty.getViewState === 'function') {
        var vs = global.RegSlayerParty.getViewState();
        if (vs && vs.mode === 'shared' && vs.mapId) return String(vs.mapId);
      }
      if (global.RegSlayerParty && global.RegSlayerParty.activeMapId) {
        return String(global.RegSlayerParty.activeMapId);
      }
    } catch (e) {}
    return null;
  }

  function eventVisibleOnDay(ev, ymd, mapContextId) {
    if (!ev || isHidden(ev.id)) return false;
    if (ev.startDate > ymd || ev.endDate < ymd) return false;
    var scope = ev.mapScope || 'personal';
    if (scope === 'all' || scope === 'personal') return true;
    if (scope === 'shared') {
      // Visible when viewing that shared map, or when no map context (planner home)
      if (!mapContextId) return true;
      if (ev.sharedMapId && String(ev.sharedMapId) === String(mapContextId)) return true;
      if (ev.mapIds && ev.mapIds.some(function (m) { return String(m) === String(mapContextId); })) return true;
      return false;
    }
    return true;
  }

  function eventsForDay(ymd, mapContextId) {
    mapContextId = mapContextId != null ? mapContextId : activeSharedMapId();
    return events.filter(function (ev) {
      return eventVisibleOnDay(ev, ymd, mapContextId);
    });
  }

  function getById(id) {
    return events.find(function (e) { return String(e.id) === String(id); }) || null;
  }

  function upsert(ev) {
    var n = normalize(ev);
    if (!n) return null;
    if (!n.creatorUserId) n.creatorUserId = myId();
    n.updatedAt = new Date().toISOString();
    var idx = events.findIndex(function (e) { return String(e.id) === String(n.id); });
    if (idx >= 0) events[idx] = Object.assign({}, events[idx], n);
    else {
      n.createdAt = n.createdAt || new Date().toISOString();
      events.push(n);
    }
    saveLocal();
    pushCloud(n);
    return getById(n.id);
  }

  function hardDelete(id) {
    var ev = getById(id);
    if (!ev) return false;
    if (!isCreator(ev)) return false;
    events = events.filter(function (e) { return String(e.id) !== String(id); });
    delete localHides[String(id)];
    saveLocal();
    try {
      var sb = global.RegSlayerCloud && global.RegSlayerCloud.getClient && global.RegSlayerCloud.getClient();
      if (sb) sb.from('map_calendar_events').delete().eq('id', id).then(function () {});
    } catch (e) {}
    return true;
  }

  function migrateLegacyDayMap(dayMap) {
    if (!dayMap || typeof dayMap !== 'object') return;
    Object.keys(dayMap).forEach(function (ds) {
      var arr = dayMap[ds];
      if (!Array.isArray(arr)) return;
      arr.forEach(function (old) {
        if (!old) return;
        var id = old.id || uid();
        if (getById(id)) return;
        upsert({
          id: id,
          text: old.text || 'Event',
          color: old.color || '#e59a18',
          startDate: ds,
          endDate: ds,
          mapScope: 'personal',
          locationId: old.locationId || null,
          weapon: old.weapon || null,
          land: old.land || null,
          creatorUserId: myId(),
          _localOnly: true
        });
      });
    });
  }

  function rowToEvent(row) {
    if (!row) return null;
    var n = normalize({
      id: row.id,
      text: row.name || row.text,
      color: row.color,
      startDate: row.start_date,
      endDate: row.end_date,
      mapScope: row.map_scope,
      sharedMapId: row.shared_map_id,
      privateMapId: row.private_map_id || (row.hunt_link && row.hunt_link.privateMapId) || null,
      lat: row.lat,
      lng: row.lng,
      locationLabel: row.location_label,
      locationId: row.hunt_link && row.hunt_link.locationId,
      weapon: row.hunt_link && row.hunt_link.weapon,
      land: row.hunt_link && row.hunt_link.land,
      creatorUserId: row.creator_user_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      hunt_link: row.hunt_link || null,
      planEventId: row.hunt_link && row.hunt_link.planEventId,
      planListId: row.hunt_link && row.hunt_link.planListId,
      inviteCode: row.hunt_link && row.hunt_link.inviteCode,
      members: row.hunt_link && row.hunt_link.members,
      listPack: row.hunt_link && row.hunt_link.listPack,
      _fromPlanSlayer: row.hunt_link && row.hunt_link.fromPlanSlayer
    });
    // Mirror Plan list pack into local bridge so View list works after cloud pull
    if (n && n.listPack) {
      try {
        var bag = JSON.parse(localStorage.getItem('slayer_event_lists_v1') || '{}') || {};
        var pack = n.listPack;
        if (n.planEventId) bag[String(n.planEventId)] = pack;
        bag['hunt:' + String(n.id)] = pack;
        if (n.planListId) bag['list:' + String(n.planListId)] = pack;
        bag[String(n.id)] = pack;
        localStorage.setItem('slayer_event_lists_v1', JSON.stringify(bag));
      } catch (eBag) {}
    }
    return n;
  }

  function eventToRow(ev) {
    return {
      id: ev.id,
      creator_user_id: ev.creatorUserId || myId(),
      name: ev.text,
      color: ev.color,
      start_date: ev.startDate,
      end_date: ev.endDate,
      map_scope: ev.mapScope || 'personal',
      shared_map_id: ev.sharedMapId || null,
      private_map_id: ev.privateMapId || null,
      lat: ev.lat,
      lng: ev.lng,
      location_label: ev.locationLabel,
      hunt_link: {
        locationId: ev.locationId,
        weapon: ev.weapon,
        land: ev.land,
        privateMapId: ev.privateMapId || null,
        planEventId: ev.planEventId || null,
        planListId: ev.planListId || null,
        inviteCode: ev.inviteCode || null,
        members: Array.isArray(ev.members) ? ev.members : [],
        listPack: ev.listPack || null,
        fromPlanSlayer: !!ev._fromPlanSlayer
      },
      updated_at: new Date().toISOString()
    };
  }

  function pushCloud(ev) {
    try {
      var sb = global.RegSlayerCloud && global.RegSlayerCloud.getClient && global.RegSlayerCloud.getClient();
      var uid = myId();
      if (!sb || !uid || !ev) return;
      var row = eventToRow(ev);
      if (!row.creator_user_id) row.creator_user_id = uid;
      // UUID ids from server; local ids may not be uuid — skip cloud if not uuid-like
      var isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(ev.id));
      if (!isUuid) {
        // insert without id, then rewrite local id if returned
        var ins = Object.assign({}, row);
        delete ins.id;
        sb.from('map_calendar_events').insert(ins).select('*').maybeSingle()
          .then(function (res) {
            if (res && res.data && res.data.id) {
              var oldId = ev.id;
              var n = rowToEvent(res.data);
              events = events.filter(function (e) { return String(e.id) !== String(oldId); });
              events.push(n);
              saveLocal();
            }
          })
          .catch(function () {});
        return;
      }
      sb.from('map_calendar_events').upsert(row).then(function () {}).catch(function () {});
    } catch (e) {}
  }

  function pullCloud() {
    try {
      var sb = global.RegSlayerCloud && global.RegSlayerCloud.getClient && global.RegSlayerCloud.getClient();
      var uid = myId();
      if (!sb || !uid) return Promise.resolve();
      return sb.from('map_calendar_events').select('*').then(function (res) {
        if (res.error || !res.data) return;
        res.data.forEach(function (row) {
          var n = rowToEvent(row);
          if (!n) return;
          var idx = events.findIndex(function (e) { return String(e.id) === String(n.id); });
          if (idx >= 0) {
            var local = events[idx];
            if (new Date(n.updatedAt || 0) >= new Date(local.updatedAt || 0)) events[idx] = n;
          } else events.push(n);
        });
        saveLocal();
      }).then(function () {
        return sb.from('map_calendar_event_hides').select('event_id').eq('user_id', uid);
      }).then(function (res) {
        if (res && res.data) {
          res.data.forEach(function (h) {
            if (h.event_id) localHides[String(h.event_id)] = true;
          });
          saveLocal();
        }
      }).catch(function () {});
    } catch (e) {
      return Promise.resolve();
    }
  }

  function beginLocationPick(ctx) {
    pendingLocationPick = ctx || null;
  }
  function cancelLocationPick() {
    pendingLocationPick = null;
  }
  function getPendingLocationPick() {
    return pendingLocationPick;
  }
  function applyLocationPick(lat, lng, label) {
    if (!pendingLocationPick) return null;
    var pick = pendingLocationPick;
    pendingLocationPick = null;
    var id = pick.eventId || pick.draftId;
    var ev = getById(id);
    if (ev) {
      ev.lat = lat;
      ev.lng = lng;
      if (label) ev.locationLabel = label;
      return upsert(ev);
    }
    // Draft only — return coords for form to hold
    return { draft: true, id: id, lat: lat, lng: lng, locationLabel: label || null, name: pick.name };
  }

  function init(legacyDayMap) {
    if (ready) return;
    loadLocal();
    if (legacyDayMap && !events.length) migrateLegacyDayMap(legacyDayMap);
    // Seed demos only if completely empty
    if (!events.length) {
      events = [
        normalize({
          id: 'e1', text: 'Bankhead Camp Opening', color: '#e59a18',
          startDate: '2026-11-14', endDate: '2026-11-14',
          mapScope: 'personal', locationId: 5, weapon: 'Primitive', land: 'Public'
        }),
        normalize({
          id: 'e2', text: 'Talladega Gun Hunt Trip', color: '#d94136',
          startDate: '2026-11-21', endDate: '2026-11-21',
          mapScope: 'personal', locationId: 6, weapon: 'Gun', land: 'Public'
        })
      ].filter(Boolean);
      saveLocal();
    }
    ready = true;
    // Soft pull when cloud available
    setTimeout(function () { pullCloud(); }, 800);
  }

  global.RegSlayerCalendarEvents = {
    STORAGE_KEY: STORAGE_KEY,
    init: init,
    localYmd: localYmd,
    parseYmd: parseYmd,
    uid: uid,
    all: function () { return events.slice(); },
    eventsForDay: eventsForDay,
    getById: getById,
    upsert: upsert,
    hardDelete: hardDelete,
    hideForMe: hideForMe,
    unhideForMe: unhideForMe,
    isCreator: isCreator,
    isHidden: isHidden,
    myId: myId,
    activeSharedMapId: activeSharedMapId,
    beginLocationPick: beginLocationPick,
    cancelLocationPick: cancelLocationPick,
    getPendingLocationPick: getPendingLocationPick,
    applyLocationPick: applyLocationPick,
    pullCloud: pullCloud,
    saveLocal: saveLocal
  };
})(typeof window !== 'undefined' ? window : this);

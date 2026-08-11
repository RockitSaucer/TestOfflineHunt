/**
 * PlanEventsListsKit — PlanSlayer event cards + floating lists for Hunt (TestOfflineHunt)
 *
 * Source of truth for list/event UX: Desktop/PlanSlayer (APP_VERSION pin there).
 * Storage (shared with PlanSlayer when same browser profile):
 *   - plan_slayer_free_lists_v1
 *   - slayer_event_lists_v1
 *   - reg_slayer_cal_events_v2 (Hunt calendar — via host helpers)
 *
 * Host hooks (optional window functions):
 *   goToEventLocation, startEditEventById, hideEventFromMyCalendar,
 *   deleteEventForEveryone, openQuickLoadMenu, showAppCopyToast,
 *   RegSlayerCalendarEvents
 */
(function (global) {
  'use strict';

  var FREE_LISTS_KEY = 'plan_slayer_free_lists_v1';
  var SLAYER_EVENT_LISTS_KEY = 'slayer_event_lists_v1';
  var ME_KEY = 'plan_slayer_my_id_v1';

  var state = {
    activeEventId: null,
    activeListId: null,
    expandedItemId: null,
    floatOpen: false,
    focusEventId: null
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function uid() {
    return 'ps_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }
  function loadJson(key, fb) {
    try {
      var r = localStorage.getItem(key);
      return r ? JSON.parse(r) : fb;
    } catch (e) { return fb; }
  }
  function saveJson(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (e) { return false; }
  }
  function myId() {
    try {
      if (global.supabaseAuthUser && global.supabaseAuthUser.id) return String(global.supabaseAuthUser.id);
    } catch (e) {}
    try {
      var a = localStorage.getItem('sb-grvhmktqzrivbqbczkii-auth-token');
      if (a) {
        var j = JSON.parse(a);
        if (j && j.user && j.user.id) return String(j.user.id);
      }
    } catch (e2) {}
    var local = loadJson(ME_KEY, null);
    if (local && local.id) return String(local.id);
    var id = 'local_' + Math.random().toString(36).slice(2, 9);
    saveJson(ME_KEY, { id: id });
    return id;
  }
  function myName() {
    try {
      if (global.supabaseAuthUser && global.supabaseAuthUser.user_metadata) {
        return global.supabaseAuthUser.user_metadata.display_name ||
          global.supabaseAuthUser.email || 'Me';
      }
    } catch (e) {}
    return 'Me';
  }
  function toast(msg) {
    if (typeof global.showAppCopyToast === 'function') {
      try { global.showAppCopyToast(String(msg)); return; } catch (e) {}
    }
    try { console.info('[PlanKit]', msg); } catch (e2) {}
  }

  /* ——— Countdown (PlanSlayer) ——— */
  function countdownParts(startAt, endAt) {
    if (!startAt) return null;
    var start = new Date(startAt);
    if (isNaN(start.getTime())) return null;
    var end = endAt ? new Date(endAt) : null;
    var now = new Date();
    if (end && !isNaN(end.getTime()) && now >= start && now <= end) {
      return { mode: 'now', text: 'Happening now!', urgent: false };
    }
    if (now >= start && (!end || isNaN(end.getTime()))) {
      return { mode: 'now', text: 'Happening now!', urgent: false };
    }
    if (end && !isNaN(end.getTime()) && now > end) return { mode: 'past', text: '', urgent: false };
    if (now > start && (!end || isNaN(end.getTime()))) return { mode: 'past', text: '', urgent: false };
    var ms = start - now;
    if (ms <= 0) return { mode: 'now', text: 'Happening now!', urgent: false };
    var sec = Math.floor(ms / 1000);
    var days = Math.floor(sec / 86400);
    sec -= days * 86400;
    var hours = Math.floor(sec / 3600);
    sec -= hours * 3600;
    var mins = Math.floor(sec / 60);
    var text = '';
    if (days > 0) text = days + 'd ' + hours + 'h';
    else if (hours > 0) text = hours + 'h ' + mins + 'm';
    else text = mins + 'm';
    return { mode: 'live', text: text, urgent: days === 0 && hours < 12 };
  }
  function countdownHtml(startAt, endAt) {
    var p = countdownParts(startAt, endAt);
    if (!p) return '';
    if (p.mode === 'now') return '<span class="cd cd-now">Happening now!</span>';
    if (p.mode === 'past') return '';
    return '<span class="cd cd-live' + (p.urgent ? ' is-urgent' : '') +
      '"><span class="cd-tminus">T minus</span> ' + esc(p.text) + '</span>';
  }

  function huntEventStartIso(ev) {
    if (!ev) return null;
    if (ev.start_at) return ev.start_at;
    if (ev.startDate) {
      var t = ev.startTime || '00:00';
      return ev.startDate + 'T' + (t.length === 5 ? t + ':00' : t);
    }
    return null;
  }
  function huntEventEndIso(ev) {
    if (!ev) return null;
    if (ev.end_at) return ev.end_at;
    if (ev.endDate) {
      var t = ev.endTime || '23:59';
      return ev.endDate + 'T' + (t.length === 5 ? t + ':00' : t);
    }
    return huntEventStartIso(ev);
  }
  function huntEventName(ev) {
    return (ev && (ev.text || ev.name || 'Event')) || 'Event';
  }

  /* ——— Lists store ——— */
  function loadFreeListsStore() {
    var s = loadJson(FREE_LISTS_KEY, null) || {};
    if (!s.named) s.named = [];
    return s;
  }
  function saveFreeListsStore(store) {
    return saveJson(FREE_LISTS_KEY, store);
  }
  function loadSlayerBag() {
    return loadJson(SLAYER_EVENT_LISTS_KEY, {}) || {};
  }
  function allNamedLists() {
    var store = loadFreeListsStore();
    return (store.named || []).filter(function (n) { return n && n.id; });
  }
  function findNamedListById(id) {
    if (!id) return null;
    return allNamedLists().find(function (n) { return String(n.id) === String(id); }) || null;
  }
  function saveNamedList(list) {
    if (!list || !list.id) return false;
    var store = loadFreeListsStore();
    var i = (store.named || []).findIndex(function (n) { return String(n.id) === String(list.id); });
    list.updated_at = new Date().toISOString();
    if (i >= 0) store.named[i] = list;
    else store.named.push(list);
    // Mirror into slayer bridge for Hunt View list / Plan dual-read
    try {
      var bag = loadSlayerBag();
      var snap = {
        listId: list.id,
        name: list.name,
        eventId: list.eventId || null,
        eventName: list.name,
        columns: (list.columns || []).map(function (c) {
          return {
            id: c.id,
            name: c.name,
            items: (c.items || []).map(function (it) {
              return {
                id: it.id, title: it.title, qty: it.qty, claims: it.claims || {},
                qualifier: it.qualifier, priority: it.priority, highlight: it.highlight,
                highlight_color: it.highlight_color, notes: it.notes,
                due_mode: it.due_mode, due_days: it.due_days
              };
            })
          };
        }),
        updated_at: list.updated_at
      };
      bag['list:' + list.id] = snap;
      if (list.eventId) bag[String(list.eventId)] = snap;
      saveJson(SLAYER_EVENT_LISTS_KEY, bag);
    } catch (eM) {}
    return saveFreeListsStore(store);
  }
  function ensureColumns(list) {
    if (!list.columns || !list.columns.length) {
      list.columns = [
        { id: 'todo', name: 'To do', items: [] },
        { id: 'buy', name: 'To buy', items: [] },
        { id: 'bring', name: 'To bring', items: [] }
      ];
    }
    list.columns.forEach(function (c) {
      if (!c.items) c.items = [];
      c.items.forEach(function (it) {
        if (!it.id) it.id = uid();
        if (!it.claims || typeof it.claims !== 'object') it.claims = {};
      });
    });
    return list;
  }
  function findListForHuntEvent(ev) {
    if (!ev) return null;
    var store = loadFreeListsStore();
    var named = store.named || [];
    // Direct eventId link
    var hit = named.find(function (n) {
      return n && n.eventId && String(n.eventId) === String(ev.id);
    });
    if (hit) return ensureColumns(hit);
    if (ev.planListId) {
      hit = named.find(function (n) { return String(n.id) === String(ev.planListId); });
      if (hit) return ensureColumns(hit);
    }
    if (ev.planEventId) {
      hit = named.find(function (n) {
        return n && n.eventId && String(n.eventId) === String(ev.planEventId);
      });
      if (hit) return ensureColumns(hit);
    }
    // Bridge bag → materialize into free lists for editing
    var bag = loadSlayerBag();
    var pack = null;
    if (ev.listPack) pack = ev.listPack;
    else if (ev.planListId && bag['list:' + ev.planListId]) pack = bag['list:' + ev.planListId];
    else if (bag['hunt:' + ev.id]) pack = bag['hunt:' + ev.id];
    else if (bag[String(ev.id)]) pack = bag[String(ev.id)];
    else if (ev.planEventId && bag[String(ev.planEventId)]) pack = bag[String(ev.planEventId)];
    if (pack && (pack.columns || pack.name)) {
      var list = {
        id: pack.listId || ('bridge_' + ev.id),
        name: pack.name || (huntEventName(ev) + ' · lists'),
        eventId: pack.eventId || ev.planEventId || ev.id,
        columns: (pack.columns || []).map(function (c) {
          return {
            id: c.id || uid(),
            name: c.name || c.id,
            items: (c.items || []).map(function (it) {
              return Object.assign({ id: it.id || uid(), claims: it.claims || {} }, it);
            })
          };
        })
      };
      ensureColumns(list);
      saveNamedList(list);
      return list;
    }
    // Create empty packing list linked to this Hunt event
    var created = {
      id: uid(),
      name: huntEventName(ev) + ' · lists',
      eventId: String(ev.id),
      columns: [
        { id: 'todo', name: 'To do', items: [] },
        { id: 'buy', name: 'To buy', items: [] },
        { id: 'bring', name: 'To bring', items: [] }
      ],
      created_at: new Date().toISOString()
    };
    saveNamedList(created);
    return created;
  }
  function personalListsOnly() {
    return allNamedLists().filter(function (n) {
      return !n.eventId && !n.isPersonalEventList && !n.personalForEventId;
    });
  }
  function eventLinkedLists() {
    return allNamedLists().filter(function (n) {
      return !!(n.eventId || n.isPersonalEventList || n.personalForEventId);
    });
  }

  /* ——— Claims / Got it / Drop ——— */
  function claimsFilled(item) {
    var need = Math.max(1, Number(item.qty) || 1);
    var total = 0;
    var parts = [];
    Object.keys(item.claims || {}).forEach(function (uid) {
      var q = Number(item.claims[uid]) || 0;
      if (q > 0) {
        total += q;
        parts.push({ uid: uid, qty: q });
      }
    });
    return { need: need, total: total, parts: parts };
  }
  function isItemAccounted(item) {
    var c = claimsFilled(item);
    return c.total >= c.need;
  }
  function myClaimQty(item) {
    var me = myId();
    return Number((item.claims || {})[me] || (item.claims || {})[String(me)] || 0);
  }
  function clearMyClaims(item) {
    if (!item.claims) item.claims = {};
    var me = myId();
    delete item.claims[me];
    delete item.claims[String(me)];
  }
  function claimFaceStyle(item) {
    var c = claimsFilled(item);
    if (!c.parts.length) {
      return 'background:linear-gradient(180deg,#2a3224 0%,#1a2018 45%,#12160f 100%);';
    }
    // Member bands — colors from simple hash if no palette
    var palette = ['#e59a18', '#3b82f6', '#16a34a', '#9333ea', '#ef4444', '#0ea5e9'];
    var stops = [];
    var at = 0;
    c.parts.forEach(function (p, i) {
      var w = (p.qty / Math.max(c.need, c.total)) * 100;
      var col = palette[i % palette.length];
      var a = at;
      var b = Math.min(100, at + w);
      stops.push(col + ' ' + a.toFixed(1) + '%');
      stops.push(col + ' ' + b.toFixed(1) + '%');
      at = b;
    });
    if (at < 99.5) {
      stops.push('#1a2018 ' + at.toFixed(1) + '%');
      stops.push('#12160f 100%');
    }
    return 'background:linear-gradient(90deg,' + stops.join(',') + ');';
  }

  function renderItemRow(item, colId) {
    if (!item || !item.id) return '';
    if (!item.claims) item.claims = {};
    var mine = myClaimQty(item);
    var done = isItemAccounted(item);
    var hasClaim = claimsFilled(item).parts.length > 0;
    var exp = state.expandedItemId === item.id ? ' is-expanded' : '';
    var full = (done ? ' is-full is-complete' : '') + (hasClaim ? ' is-claimed' : '');
    var showDrop = done && mine > 0;
    var face = claimFaceStyle(item);
    var titleColor = done ? '#4ade80' : '#f0f4ee';
    return (
      '<div class="list-item' + exp + full + '" style="' + face + '" data-item-id="' + esc(item.id) +
        '" data-col-id="' + esc(colId) + '">' +
        '<div class="li-row">' +
          '<button type="button" class="li-face" data-act="expand">' +
            '<span class="li-title" style="color:' + titleColor + '">' + esc(item.title || 'Item') + '</span>' +
            ((item.qty || 1) > 1 ? ' <span class="li-qty">×' + (item.qty || 1) + '</span>' : '') +
          '</button>' +
          '<div class="li-actions">' +
            (showDrop
              ? '<button type="button" class="btn-got btn-drop is-on" data-act="drop">Drop</button>'
              : '<button type="button" class="btn-got' + (mine > 0 ? ' is-on' : '') +
                '" data-act="got">Got it!</button>') +
          '</div>' +
        '</div>' +
        '<div class="li-detail">' +
          '<div class="field-row">' +
            '<div class="field" style="flex:1 1 140px"><label>Title</label>' +
              '<input data-f="title" value="' + esc(item.title || '') + '" /></div>' +
            '<div class="field" style="width:72px"><label>Qty</label>' +
              '<input data-f="qty" type="number" min="1" value="' + (item.qty || 1) + '" /></div>' +
            '<div class="field" style="width:100px"><label>Priority</label>' +
              '<select data-f="priority">' +
                '<option value="0"' + (!item.priority ? ' selected' : '') + '>Normal</option>' +
                '<option value="1"' + (item.priority == 1 ? ' selected' : '') + '>High</option>' +
                '<option value="2"' + (item.priority == 2 ? ' selected' : '') + '>Urgent</option>' +
              '</select></div>' +
          '</div>' +
          '<div style="margin-top:8px"><label>Note</label>' +
            '<textarea data-f="notes" placeholder="Add a note…">' + esc(item.notes || '') + '</textarea></div>' +
          '<label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12px">' +
            '<input type="checkbox" data-f="highlight" ' + (item.highlight ? 'checked' : '') + ' /> Highlight</label>' +
          '<div class="li-detail-actions">' +
            '<button type="button" class="btn-item-del" data-act="del">Delete</button>' +
            '<button type="button" class="btn-primary" data-act="save-detail">Save</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function renderTriad(list) {
    list = ensureColumns(list);
    var html = '<div class="list-triad" data-list-id="' + esc(list.id) + '">';
    (list.columns || []).forEach(function (col) {
      if (!col || col.id === 'personal') return;
      var body = (col.items || []).map(function (it) {
        return renderItemRow(it, col.id);
      }).join('') || '<p class="empty">Nothing here yet.</p>';
      html +=
        '<div class="list-col" data-col-kind="' + esc(col.id) + '">' +
          '<div class="list-col-head"><span class="list-col-title">' +
            esc(col.name || col.id) + '</span></div>' +
          '<div class="list-col-body">' + body + '</div>' +
          '<div class="list-col-add">' +
            '<input type="text" class="list-col-add-input" data-col-add-input="' + esc(col.id) +
              '" placeholder="Type item, press Enter…" autocomplete="off" />' +
            '<button type="button" class="list-col-add-btn" data-col-add="' + esc(col.id) + '">Add</button>' +
          '</div>' +
        '</div>';
    });
    html += '</div>';
    return html;
  }

  /* ——— Float window ——— */
  function ensureFloatDom() {
    if ($('ps-list-float')) return;
    var backdrop = document.createElement('div');
    backdrop.id = 'ps-list-float-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    document.body.appendChild(backdrop);
    var el = document.createElement('div');
    el.id = 'ps-list-float';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML =
      '<div class="ps-float-head" id="ps-list-float-head">' +
        '<div style="min-width:0;flex:1">' +
          '<div class="ps-float-title" id="ps-list-float-title">Lists</div>' +
          '<div class="ps-float-sub" id="ps-list-float-sub">PlanSlayer lists · same options</div>' +
        '</div>' +
        '<button type="button" class="ps-float-close" id="ps-list-float-close" title="Minimize back to List">×</button>' +
      '</div>' +
      '<div class="ps-float-body">' +
        '<nav class="ps-float-nav" id="ps-list-float-nav"></nav>' +
        '<div class="ps-float-main" id="ps-list-float-main"></div>' +
      '</div>';
    document.body.appendChild(el);
    backdrop.addEventListener('click', closeListFloat);
    $('ps-list-float-close').addEventListener('click', closeListFloat);
    // Drag float by head
    var drag = null;
    $('ps-list-float-head').addEventListener('pointerdown', function (e) {
      if (e.target && e.target.closest && e.target.closest('button')) return;
      var box = $('ps-list-float');
      var r = box.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      box.style.transform = 'none';
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      try { e.target.setPointerCapture(e.pointerId); } catch (eC) {}
    });
    window.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var box = $('ps-list-float');
      if (!box) return;
      box.style.left = Math.max(8, drag.left + (e.clientX - drag.x)) + 'px';
      box.style.top = Math.max(8, drag.top + (e.clientY - drag.y)) + 'px';
    });
    window.addEventListener('pointerup', function () { drag = null; });
    // Nav + triad events
    el.addEventListener('click', onFloatClick);
    el.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var inp = e.target && e.target.closest && e.target.closest('[data-col-add-input]');
      if (!inp) return;
      e.preventDefault();
      submitAdd(inp.getAttribute('data-col-add-input'), inp);
    });
  }

  function renderFloatNav(preferListId) {
    var nav = $('ps-list-float-nav');
    if (!nav) return;
    var personal = personalListsOnly();
    var eventLists = eventLinkedLists();
    var html = '';
    html += '<div class="ps-nav-label">Personal lists</div>';
    if (!personal.length) html += '<p class="empty" style="padding:6px">None yet — create in PlanSlayer or open an event List.</p>';
    else {
      personal.forEach(function (n) {
        var on = String(n.id) === String(state.activeListId);
        html += '<button type="button" class="ps-nav-item' + (on ? ' is-active' : '') +
          '" data-open-list="' + esc(n.id) + '">' + esc(n.name || 'List') + '</button>';
      });
    }
    html += '<div class="ps-nav-label">Event lists</div>';
    if (!eventLists.length) html += '<p class="empty" style="padding:6px">None yet</p>';
    else {
      eventLists.forEach(function (n) {
        var on = String(n.id) === String(state.activeListId);
        html += '<button type="button" class="ps-nav-item' + (on ? ' is-active' : '') +
          '" data-open-list="' + esc(n.id) + '">' + esc(n.name || 'List') + '</button>';
      });
    }
    nav.innerHTML = html;
  }

  function renderFloatMain() {
    var main = $('ps-list-float-main');
    if (!main) return;
    var list = findNamedListById(state.activeListId);
    if (!list) {
      main.innerHTML = '<div class="ps-float-empty">Select a list on the left — or open <strong>List</strong> from an event to create its packing pack.</div>';
      return;
    }
    ensureColumns(list);
    var title = $('ps-list-float-title');
    if (title) title.textContent = list.name || 'List';
    var cd = '';
    // If list is event-linked, show countdown from Hunt calendar event if present
    if (list.eventId && global.RegSlayerCalendarEvents) {
      try {
        var ev = global.RegSlayerCalendarEvents.getById(list.eventId);
        if (ev) cd = countdownHtml(huntEventStartIso(ev), huntEventEndIso(ev));
      } catch (e) {}
    }
    main.innerHTML =
      '<div class="ps-float-main-title">' + esc(list.name || 'List') + '</div>' +
      (cd ? ('<div class="ps-float-main-cd">' + cd + '</div>') : '') +
      '<div class="ps-float-triad-wrap">' + renderTriad(list) + '</div>';
  }

  function openListFloat(opts) {
    opts = opts || {};
    ensureFloatDom();
    state.floatOpen = true;
    if (opts.event) {
      state.focusEventId = opts.event.id;
      var list = findListForHuntEvent(opts.event);
      if (list) state.activeListId = list.id;
    }
    if (opts.listId) state.activeListId = opts.listId;
    if (!state.activeListId) {
      var all = allNamedLists();
      if (all[0]) state.activeListId = all[0].id;
    }
    renderFloatNav();
    renderFloatMain();
    var box = $('ps-list-float');
    var bd = $('ps-list-float-backdrop');
    if (box) {
      box.classList.add('is-open');
      box.setAttribute('aria-hidden', 'false');
    }
    if (bd) {
      bd.classList.add('is-open');
      bd.setAttribute('aria-hidden', 'false');
    }
  }

  function closeListFloat() {
    state.floatOpen = false;
    state.expandedItemId = null;
    var box = $('ps-list-float');
    var bd = $('ps-list-float-backdrop');
    if (box) {
      box.classList.remove('is-open');
      box.setAttribute('aria-hidden', 'true');
    }
    if (bd) {
      bd.classList.remove('is-open');
      bd.setAttribute('aria-hidden', 'true');
    }
    // Minimize back into List button — event card stays expanded if it was
    toast('List minimized — tap List under T minus to reopen');
  }

  function getActiveList() {
    return findNamedListById(state.activeListId);
  }
  function findItemInList(list, itemId) {
    if (!list) return null;
    ensureColumns(list);
    for (var i = 0; i < (list.columns || []).length; i++) {
      var c = list.columns[i];
      var idx = (c.items || []).findIndex(function (x) { return String(x.id) === String(itemId); });
      if (idx >= 0) return { col: c, item: c.items[idx], index: idx, colId: c.id };
    }
    return null;
  }

  function submitAdd(colId, inp) {
    var list = getActiveList();
    if (!list || !colId) return;
    ensureColumns(list);
    var title = inp ? String(inp.value || '').trim() : '';
    if (!title) { toast('Type an item name first'); return; }
    var col = list.columns.find(function (c) { return String(c.id) === String(colId); });
    if (!col) return;
    col.items.push({
      id: uid(),
      title: title.charAt(0).toUpperCase() + title.slice(1),
      qty: 1,
      claims: {},
      priority: 0,
      qualifier: 'other',
      notes: '',
      created_at: new Date().toISOString()
    });
    saveNamedList(list);
    if (inp) inp.value = '';
    renderFloatMain();
  }

  function onFloatClick(e) {
    var t = e.target;
    if (!t || !t.closest) return;

    var nav = t.closest('[data-open-list]');
    if (nav) {
      state.activeListId = nav.getAttribute('data-open-list');
      state.expandedItemId = null;
      renderFloatNav();
      renderFloatMain();
      return;
    }

    var addBtn = t.closest('[data-col-add]');
    if (addBtn) {
      var colId = addBtn.getAttribute('data-col-add');
      var wrap = addBtn.closest('.list-col-add');
      var inp = wrap && wrap.querySelector('input');
      submitAdd(colId, inp);
      return;
    }

    var row = t.closest('.list-item');
    if (!row) return;
    if (t.closest('.li-detail input, .li-detail select, .li-detail textarea, .li-detail label')) return;

    var actBtn = t.closest('[data-act]');
    var action = actBtn ? actBtn.getAttribute('data-act') : 'expand';
    var itemId = row.getAttribute('data-item-id');
    var list = getActiveList();
    var hit = findItemInList(list, itemId);
    if (!hit) return;
    var item = hit.item;

    if (action === 'expand' || action === 'face') {
      state.expandedItemId = state.expandedItemId === itemId ? null : itemId;
      renderFloatMain();
      return;
    }
    if (action === 'got') {
      if (!item.claims) item.claims = {};
      if (isItemAccounted(item) && myClaimQty(item) > 0) {
        clearMyClaims(item);
        toast('Dropped — back on the list');
      } else if (myClaimQty(item) > 0) {
        clearMyClaims(item);
      } else {
        item.claims[myId()] = Math.max(1, Number(item.qty) || 1) >= 1 ? 1 : 1;
        // For qty 1 claim 1; multi still claims 1 for now (qty modal later)
        if (Math.max(1, Number(item.qty) || 1) === 1) item.claims[myId()] = 1;
        else item.claims[myId()] = 1;
      }
      saveNamedList(list);
      renderFloatMain();
      return;
    }
    if (action === 'drop') {
      clearMyClaims(item);
      saveNamedList(list);
      toast('Dropped — back on the list');
      renderFloatMain();
      return;
    }
    if (action === 'del') {
      if (!confirm('Delete “' + (item.title || 'item') + '”?')) return;
      hit.col.items.splice(hit.index, 1);
      if (state.expandedItemId === itemId) state.expandedItemId = null;
      saveNamedList(list);
      renderFloatMain();
      return;
    }
    if (action === 'save-detail') {
      var titleEl = row.querySelector('[data-f="title"]');
      var qtyEl = row.querySelector('[data-f="qty"]');
      var priEl = row.querySelector('[data-f="priority"]');
      var notesEl = row.querySelector('[data-f="notes"]');
      var hlEl = row.querySelector('[data-f="highlight"]');
      if (titleEl) item.title = String(titleEl.value || '').trim() || item.title;
      if (qtyEl) item.qty = Math.max(1, parseInt(qtyEl.value, 10) || 1);
      if (priEl) item.priority = parseInt(priEl.value, 10) || 0;
      if (notesEl) item.notes = notesEl.value || '';
      if (hlEl) item.highlight = !!hlEl.checked;
      state.expandedItemId = null;
      saveNamedList(list);
      renderFloatMain();
      toast('Saved');
      return;
    }
  }

  /* ——— Day events list (replaces Hunt dropdown cards) ——— */
  function renderDayEventsHtml(dayEvents, hiddenDay) {
    var htmlOut = '';
    if (dayEvents && dayEvents.length) {
      htmlOut = dayEvents.map(function (ev) {
        var id = String(ev.id);
        var active = String(state.activeEventId) === id;
        var name = huntEventName(ev);
        var startIso = huntEventStartIso(ev);
        var endIso = huntEventEndIso(ev);
        var cd = countdownHtml(startIso, endIso);
        var range = (ev.startDate === ev.endDate || !ev.endDate)
          ? (ev.startDate || '')
          : ((ev.startDate || '') + ' → ' + (ev.endDate || ''));
        var scopeLabel = ev.mapScope === 'shared' ? 'Shared map'
          : (ev.mapScope === 'all' ? 'All my maps' : 'Personal');
        var isCreator = true;
        try {
          if (global.RegSlayerCalendarEvents && global.RegSlayerCalendarEvents.isCreator) {
            isCreator = global.RegSlayerCalendarEvents.isCreator(ev);
          }
        } catch (eC) {}
        var color = ev.color || '#e59a18';
        var metaBits = [];
        if (range) metaBits.push(range);
        if (scopeLabel) metaBits.push(scopeLabel);
        return (
          '<div class="ps-event-card-wrap">' +
            '<div class="ps-event-card' + (active ? ' is-active' : '') + '" data-ps-open-event="' + esc(id) +
              '" style="border-left-color:' + esc(color) + '" role="button" tabindex="0">' +
              '<div class="ec-top">' +
                '<strong class="ec-name">' + esc(name) + '</strong>' +
                (cd ? ('<span class="ec-countdown">' + cd + '</span>') : '') +
                (isCreator
                  ? ('<button type="button" class="ec-edit-btn" data-ps-edit-event="' + esc(id) +
                    '">Edit event</button>')
                  : '') +
              '</div>' +
              (metaBits.length ? ('<div class="ec-meta">' + esc(metaBits.join(' · ')) + '</div>') : '') +
              '<div class="ps-event-detail" data-ps-detail="' + esc(id) + '">' +
                '<div class="ps-tminus-block">' +
                  (cd || '<span class="cd muted">No start time</span>') +
                '</div>' +
                '<button type="button" class="ps-list-btn" data-ps-open-list="' + esc(id) +
                  '">List</button>' +
                '<div class="ps-action-row">' +
                  (ev.lat != null
                    ? ('<button type="button" data-ps-map="' + esc(id) + '">Map</button>')
                    : '') +
                  '<button type="button" class="ps-ql" data-ps-ql="' + esc(id) + '">Quick Load</button>' +
                  '<button type="button" data-ps-hide="' + esc(id) + '">Hide</button>' +
                  (isCreator
                    ? ('<button type="button" class="ps-danger" data-ps-del="' + esc(id) + '">Delete</button>')
                    : '') +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>'
        );
      }).join('');
    }
    if (hiddenDay && hiddenDay.length) {
      htmlOut += '<div class="ps-hidden-label">Hidden on your calendar (not deleted)</div>';
      htmlOut += hiddenDay.map(function (ev) {
        var range = ev.startDate === ev.endDate ? ev.startDate : (ev.startDate + ' → ' + ev.endDate);
        return '<div class="ps-event-card-wrap">' +
          '<div class="ps-event-card" style="opacity:0.92;border-style:dashed">' +
            '<div class="ec-top"><strong class="ec-name" style="color:var(--muted)">' +
              esc(huntEventName(ev)) + '</strong></div>' +
            '<div class="ec-meta">' + esc(range) + ' · hidden for you only</div>' +
            '<div class="ps-event-detail" style="display:block">' +
              '<button type="button" class="ps-list-btn" style="background:#2f5a20" data-ps-unhide="' +
                esc(ev.id) + '">Unhide</button>' +
            '</div>' +
          '</div></div>';
      }).join('');
    }
    return htmlOut;
  }

  function wireDayListClicks(root) {
    if (!root || root._psWired) return;
    root._psWired = true;
    root.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;

      var edit = t.closest('[data-ps-edit-event]');
      if (edit) {
        e.preventDefault();
        e.stopPropagation();
        var eid = edit.getAttribute('data-ps-edit-event');
        if (typeof global.startEditEventById === 'function') global.startEditEventById(eid);
        return;
      }
      var openList = t.closest('[data-ps-open-list]');
      if (openList) {
        e.preventDefault();
        e.stopPropagation();
        var idL = openList.getAttribute('data-ps-open-list');
        var evL = global.RegSlayerCalendarEvents && global.RegSlayerCalendarEvents.getById(idL);
        openListFloat({ event: evL || { id: idL, text: 'Event' } });
        return;
      }
      var mapB = t.closest('[data-ps-map]');
      if (mapB) {
        e.preventDefault();
        e.stopPropagation();
        if (typeof global.goToEventLocation === 'function') {
          global.goToEventLocation(mapB.getAttribute('data-ps-map'));
        }
        return;
      }
      var ql = t.closest('[data-ps-ql]');
      if (ql) {
        e.preventDefault();
        e.stopPropagation();
        if (typeof global.openQuickLoadMenu === 'function') {
          global.openQuickLoadMenu(ql.getAttribute('data-ps-ql'));
        }
        return;
      }
      var hide = t.closest('[data-ps-hide]');
      if (hide) {
        e.preventDefault();
        e.stopPropagation();
        if (typeof global.hideEventFromMyCalendar === 'function') {
          global.hideEventFromMyCalendar(hide.getAttribute('data-ps-hide'));
        }
        return;
      }
      var del = t.closest('[data-ps-del]');
      if (del) {
        e.preventDefault();
        e.stopPropagation();
        if (typeof global.deleteEventForEveryone === 'function') {
          global.deleteEventForEveryone(del.getAttribute('data-ps-del'));
        }
        return;
      }
      var unh = t.closest('[data-ps-unhide]');
      if (unh) {
        e.preventDefault();
        e.stopPropagation();
        if (typeof global.unhideEventOnMyCalendar === 'function') {
          global.unhideEventOnMyCalendar(unh.getAttribute('data-ps-unhide'));
        }
        return;
      }
      var card = t.closest('[data-ps-open-event]');
      if (card) {
        var id = card.getAttribute('data-ps-open-event');
        state.activeEventId = String(state.activeEventId) === String(id) ? null : id;
        // Re-render via host if available
        if (typeof global.updateEventsList === 'function') {
          try { global.updateEventsList(); return; } catch (eU) {}
        }
        // Fallback: toggle class
        root.querySelectorAll('.ps-event-card').forEach(function (el) {
          el.classList.toggle('is-active', el.getAttribute('data-ps-open-event') === state.activeEventId);
        });
      }
    });
  }

  /**
   * Replace Hunt's calendar-events-list contents with Plan-style cards.
   * Call from updateEventsList after computing dayEvents / hiddenDay.
   */
  function paintDayEventsList(dayEvents, hiddenDay) {
    var list = $('calendar-events-list');
    if (!list) return false;
    list.innerHTML = renderDayEventsHtml(dayEvents || [], hiddenDay || []) ||
      '<p class="empty" style="color:var(--muted);font-size:12px">No trips on this day.</p>';
    wireDayListClicks(list);
    return true;
  }

  // Live countdown tick for cards + float
  setInterval(function () {
    try {
      document.querySelectorAll('#calendar-events-list .ps-event-card.is-active, #ps-list-float.is-open').forEach(function () {});
      // Light refresh of visible countdowns via re-paint only when float closed & active event
      if (!state.floatOpen && state.activeEventId && typeof global.updateEventsList === 'function') {
        // skip full re-render every 15s — host countdown optional
      }
    } catch (e) {}
  }, 30000);

  global.PlanEventsListsKit = {
    version: '1.0.0-testofflinehunt',
    paintDayEventsList: paintDayEventsList,
    openListFloat: openListFloat,
    closeListFloat: closeListFloat,
    findListForHuntEvent: findListForHuntEvent,
    countdownHtml: countdownHtml,
    getState: function () { return state; }
  };

  // Ensure float DOM on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureFloatDom);
  } else {
    try { ensureFloatDom(); } catch (e) {}
  }
})(typeof window !== 'undefined' ? window : this);

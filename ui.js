// ============================================================
//  ui.js  –  DOM Rendering & Screen Management
//  All visual mutations live here. Receives data, renders.
// ============================================================

import { toLocalDate, p, calcStreak, getTodayItems, calcPerformanceScore, countSubjects } from './core-engine.js';

// ── Screen control ────────────────────────────────────────────
export function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
  const nav = document.querySelector('.bottom-nav');
  if (nav) nav.style.display = id === 'appScreen' ? 'flex' : 'none';
  const sidebar = document.querySelector('.sidebar');
  if (sidebar) sidebar.style.display = id === 'appScreen' ? '' : 'none';
}

// ── Toast notification ─────────────────────────────────────────
export function showToast(msg, duration = 3400) {
  const ex = document.querySelector('.toast'); if (ex) ex.remove();
  const t  = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), duration);
}

// ── Auth message ──────────────────────────────────────────────
export function showAuthMsg(id, msg, type) {
  const el = document.getElementById(id); if (!el) return;
  el.textContent = msg;
  const s = { error: 'color:#dc2626;background:#fef2f2;border-color:#fecaca', success: 'color:#16a34a;background:#f0fdf4;border-color:#bbf7d0', info: 'color:#0284c7;background:#e0f2fe;border-color:#bae6fd' };
  el.style.cssText = (s[type] || '') + ';border:1px solid;border-radius:8px;padding:8px;text-align:center;font-size:0.75rem;font-weight:500;margin-top:10px;display:block;';
}

// ── Tab switcher ──────────────────────────────────────────────
export function switchTab(name, renderCallbacks = {}) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.snav-item').forEach(n => n.classList.remove('active'));

  const page = document.getElementById(`page-${name}`);
  if (page) page.classList.add('active');

  const tabs = ['add','today','dash','log','tools','backup'];
  const idx  = tabs.indexOf(name);
  const allTabs = document.querySelectorAll('.tab');
  if (idx >= 0 && allTabs[idx]) allTabs[idx].classList.add('active');

  const navEl  = document.getElementById(`nav-${name}`);
  if (navEl)  navEl.classList.add('active');
  const snavEl = document.getElementById(`snav-${name}`);
  if (snavEl) snavEl.classList.add('active');

  if (renderCallbacks[name]) renderCallbacks[name]();
}

// ── Clock ─────────────────────────────────────────────────────
export function updateClock() {
  const now = new Date();
  const te = document.getElementById('clockTime'); if (te) te.textContent = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  const de = document.getElementById('clockDate'); if (de) de.textContent = now.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

export function syncInputTime() {
  const now = new Date();
  const sd = document.getElementById('studyDate'); if (sd) sd.value = toLocalDate(now);
  const st = document.getElementById('studyTime'); if (st) st.value = `${p(now.getHours())}:${p(now.getMinutes())}`;
}

// ── User info ─────────────────────────────────────────────────
export function renderUserInfo(user) {
  const name  = user.displayName || user.email || 'U';
  const abbr  = name[0].toUpperCase();
  const email = user.email;
  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setEl('userAvatar',    abbr);
  setEl('menuName',      name);
  setEl('menuEmail',     email);
  setEl('sidebarAvatar', abbr);
  setEl('sidebarName',   name);
  setEl('sidebarEmail',  email);
}

// ── Today badge ───────────────────────────────────────────────
export function updateTodayBadge(entries, doneSet) {
  const items   = getTodayItems(entries, doneSet);
  const pending = items.filter(i => !i.done).length;
  const badge   = document.getElementById('todayCount');
  if (!badge) return;
  if (pending > 0)      { badge.textContent = pending; badge.style.display = 'inline-block'; badge.style.background = 'var(--teal)'; }
  else if (items.length) { badge.textContent = '✓'; badge.style.display = 'inline-block'; badge.style.background = 'var(--green)'; }
  else                   { badge.style.display = 'none'; }
}

// ── Today page ────────────────────────────────────────────────
export function renderToday(entries, doneSet, onToggle) {
  const items = getTodayItems(entries, doneSet);
  const dl    = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const c     = document.getElementById('todayContent');
  if (!c) return;

  if (!items.length) {
    c.innerHTML = `<div class="empty-state"><span class="emoji">✅</span><p>Nothing to revise today.<br><span style="font-size:0.76rem;color:var(--text-dim)">${dl}</span></p></div>`;
    return;
  }

  const doneCount = items.filter(i => i.done).length;
  c.innerHTML = `
    <div class="card card-green">
      <div class="card-header">
        <div class="live-dot"></div>
        <h3>Revise Today</h3>
        <span class="meta">${new Date().toLocaleDateString('en-IN',{day:'numeric',month:'short'})}</span>
      </div>
      <div style="padding:2px 16px 6px;">
        <div style="font-size:0.56rem;color:var(--text-dim);letter-spacing:.1em;text-transform:uppercase;padding:8px 0 4px;border-top:1px solid var(--border);font-weight:600;">Today's Revision List</div>
      </div>
      ${items.map(item => `
        <div class="today-item ${item.done ? 'done-item' : ''}" id="ti-${item.key}">
          <button class="check-btn ${item.done ? 'done' : ''}" data-key="${item.key}">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M2 7L6 11L12 3" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <span class="today-badge">${item.label}</span>
          <span class="today-topic">${item.topic}</span>
        </div>`).join('')}
      <div class="done-summary">
        <span>✅ ${doneCount} / ${items.length} done</span>
        ${doneCount > 0 ? `<button class="reset-btn" id="resetDoneBtn">Reset</button>` : ''}
      </div>
    </div>`;

  c.querySelectorAll('.check-btn').forEach(btn => {
    btn.addEventListener('click', () => onToggle(btn.dataset.key));
  });
}

// ── Log page ──────────────────────────────────────────────────
export function renderLog(entries, doneSet, searchQuery, onView, onDelete) {
  const totalRev = entries.reduce((a, e) => a + (e.revisions || []).length, 0);
  const todayN   = getTodayItems(entries, doneSet).length;
  const stats    = document.getElementById('statsRow');
  if (stats) stats.innerHTML = `
    <div class="stat-box"><div class="stat-num">${entries.length}</div><div class="stat-lbl">Topics</div></div>
    <div class="stat-box"><div class="stat-num">${totalRev}</div><div class="stat-lbl">Revisions</div></div>
    <div class="stat-box"><div class="stat-num">${todayN}</div><div class="stat-lbl">Due Today</div></div>`;

  renderPerformanceScore(entries, doneSet);

  const c = document.getElementById('logContainer'); if (!c) return;
  if (!entries.length) { c.innerHTML = '<div class="empty-state"><span class="emoji">📖</span><p>No entries yet.</p></div>'; return; }

  const q        = (searchQuery || '').toLowerCase().trim();
  const filtered = q ? entries.filter(e => (e.topic || '').toLowerCase().includes(q)) : entries;
  if (!filtered.length) { c.innerHTML = `<div class="empty-state"><span class="emoji">🔍</span><p>No topics found for "${q}"</p></div>`; return; }

  c.innerHTML = filtered.map(entry => {
    const [y, m, d] = (entry.dateStr || '----').split('-').map(Number);
    const dl = new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    const topic = q ? (entry.topic || '').replace(new RegExp(`(${q})`, 'gi'), '<mark style="background:#fef9c3;border-radius:3px;padding:0 2px;">$1</mark>') : (entry.topic || '');
    return `<div class="log-item">
      <div class="log-left"><div class="log-topic">${topic}</div><div class="log-meta">${dl} · ${entry.timeStr || ''} · 7 revisions</div></div>
      <div class="log-actions">
        <button class="btn-sm view-btn" data-id="${entry.id}">View</button>
        <button class="btn-sm del del-btn" data-id="${entry.id}">✕</button>
      </div>
    </div>`;
  }).join('');

  c.querySelectorAll('.view-btn').forEach(btn => btn.addEventListener('click', () => onView(btn.dataset.id)));
  c.querySelectorAll('.del-btn').forEach(btn => btn.addEventListener('click', () => onDelete(btn.dataset.id)));
}

// ── Dashboard ─────────────────────────────────────────────────
export function renderDashboard(entries, doneSet, examDates) {
  renderCountdown(examDates);
  renderSubjects(entries);
  renderStreak(entries);
  renderHeatmap(entries);
}

export function renderCountdown(dates = {}) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  function setBox(daysId, dateId, dateStr) {
    const daysEl = document.getElementById(daysId);
    const dateEl = document.getElementById(dateId);
    if (!daysEl || !dateEl) return;
    if (!dateStr) { daysEl.textContent = '--'; dateEl.textContent = 'Tap Set Dates'; daysEl.className = 'exam-days ok'; return; }
    const exam = new Date(dateStr); exam.setHours(0, 0, 0, 0);
    const diff = Math.ceil((exam - today) / (1000 * 60 * 60 * 24));
    daysEl.textContent = diff > 0 ? diff : 'Done!';
    dateEl.textContent = exam.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    daysEl.className = `exam-days ${diff <= 30 ? 'urgent' : diff <= 60 ? 'soon' : 'ok'}`;
  }
  setBox('mainDays', 'mainDateDisp', dates.mains);
  setBox('advDays',  'advDateDisp',  dates.adv);
}

export function renderSubjects(entries) {
  const total   = entries.length || 1;
  const counts  = countSubjects(entries);
  const el      = document.getElementById('subjRow'); if (!el) return;
  el.innerHTML  = ['Physics','Chemistry','Maths'].map(name => {
    const s   = counts[name] || 0;
    const pct = Math.round(s / total * 100);
    const cls = name === 'Physics' ? 'subj-phy' : name === 'Chemistry' ? 'subj-chem' : 'subj-math';
    const ico = name === 'Physics' ? '⚡' : name === 'Chemistry' ? '🧪' : '📐';
    return `<div class="subj-card ${cls}"><div class="s-icon">${ico}</div><div class="s-name">${name}</div><div class="s-num">${s}</div><div class="s-lbl">topics</div><div class="s-bar-wrap"><div class="s-bar" style="width:${pct}%"></div></div></div>`;
  }).join('');
}

export function renderStreak(entries) {
  const { current, longest, total } = calcStreak(entries);
  const el = document.getElementById('streakRow'); if (!el) return;
  el.innerHTML = `
    <div class="streak-box"><div class="streak-icon">🔥</div><div class="streak-num">${current}</div><div class="streak-lbl">Current Streak</div></div>
    <div class="streak-box"><div class="streak-icon">🏆</div><div class="streak-num">${longest}</div><div class="streak-lbl">Best Streak</div></div>
    <div class="streak-box"><div class="streak-icon">📅</div><div class="streak-num">${total}</div><div class="streak-lbl">Days Studied</div></div>`;
}

export function renderHeatmap(entries) {
  const studyCount = {};
  entries.forEach(e => { studyCount[e.dateStr] = (studyCount[e.dateStr] || 0) + 1; });
  const grid   = document.getElementById('heatmapGrid'); if (!grid) return;
  const today  = new Date(); today.setHours(0, 0, 0, 0);
  const weeks  = 26;
  const start  = new Date(today); start.setDate(start.getDate() - weeks * 7 + 1);
  const dow    = start.getDay(); start.setDate(start.getDate() - (dow === 0 ? 6 : dow - 1));
  let html = '', currentMonth = -1;
  for (let w = 0; w < weeks + 1; w++) {
    let wh = '', ml = '';
    for (let d = 0; d < 7; d++) {
      const cur = new Date(start); cur.setDate(start.getDate() + w * 7 + d);
      if (cur > today) { wh += '<div class="hday" style="background:transparent"></div>'; continue; }
      if (cur.getMonth() !== currentMonth) { currentMonth = cur.getMonth(); ml = cur.toLocaleDateString('en-IN', { month: 'short' }); }
      const ds  = toLocalDate(cur);
      const cnt = studyCount[ds] || 0;
      const lvl = cnt === 0 ? 0 : cnt === 1 ? 1 : cnt <= 2 ? 2 : cnt <= 4 ? 3 : 4;
      wh += `<div class="hday hday-${lvl}" title="${ds}: ${cnt} topics"></div>`;
    }
    html += `<div class="heatmap-month"><div class="heatmap-month-label">${ml || ''}</div><div class="heatmap-week">${wh}</div></div>`;
  }
  grid.innerHTML = html;
  const sub = document.getElementById('heatmapSub');
  if (sub) sub.textContent = `${Object.keys(studyCount).length} days studied · ${entries.length} topics logged`;
}

export function renderPerformanceScore(entries, doneSet) {
  const el = document.getElementById('perfCard');
  if (!entries.length) { if (el) el.style.display = 'none'; return; }
  const { score, done, pending, label } = calcPerformanceScore(entries, doneSet);
  const { current } = calcStreak(entries);
  if (el) el.style.display = 'block';
  const setEl = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  const scoreEl = document.getElementById('perfScore'); if (scoreEl) scoreEl.innerHTML = `${score}<span>%</span>`;
  const barEl   = document.getElementById('perfBar');   if (barEl)   barEl.style.width = `${score}%`;
  setEl('perfLabel',   label);
  setEl('perfDone',    done);
  setEl('perfPending', pending);
  setEl('perfStreak',  current);
}

// ── Result card (after adding entry) ─────────────────────────
export function showResult(entry, revisions) {
  const rc = document.getElementById('resultCard'); if (!rc) return;
  rc.style.display = 'block';
  const rt = document.getElementById('resultTopic'); if (rt) rt.textContent = entry.topic;
  const il = document.getElementById('intervalsList'); if (!il) return;
  il.innerHTML = revisions.map((r, i) => {
    const dt = r.datetime instanceof Date ? r.datetime : new Date(r.datetime);
    const dl = dt.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const tl = dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    return `<div class="iv-row" id="ivrow-${i}"><span class="iv-tag ${r.type}">${r.label}</span><div class="iv-info"><div class="iv-date">${dl}</div><div class="iv-time">${tl}</div></div></div>`;
  }).join('');
}

// ── Push notification toggle UI ────────────────────────────────
export function updateNotifToggle() {
  const toggle  = document.getElementById('notifToggle');
  const label   = document.getElementById('notifToggleLabel');
  const sub     = document.getElementById('notifSubText');
  const perm    = (typeof Notification !== 'undefined') ? Notification.permission : 'default';
  if (!toggle) return;
  if (perm === 'granted') {
    toggle.checked = true;
    if (label) label.textContent = 'ON';
    if (sub)   sub.textContent   = 'Reminders enabled — you\'ll get notified for revisions';
  } else if (perm === 'denied') {
    toggle.checked = false;
    if (label) label.textContent = 'BLOCKED';
    if (sub)   sub.textContent   = 'Notifications blocked — enable in browser settings';
  } else {
    toggle.checked = false;
    if (label) label.textContent = 'OFF';
    if (sub)   sub.textContent   = 'Tap to enable native revision reminders';
  }
}

// ── Theme toggle ──────────────────────────────────────────────
export function applyTheme(isDark) {
  document.body.classList.toggle('dark-mode', isDark);
  const btn = document.getElementById('themeBtn'); if (btn) btn.textContent = isDark ? '☀️' : '🌙';
}

// ── Global Platform Logo ──────────────────────────────────────
export function applyGlobalLogo(url) {
  // Mobile Header Logo
  const logos = document.querySelectorAll('.h-logo');
  logos.forEach(logoWrap => {
    if (url) {
      logoWrap.style.background = 'none';
      logoWrap.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
    } else {
      logoWrap.style.background = 'linear-gradient(135deg,var(--teal-dim),var(--teal))';
      logoWrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="13" height="18" rx="2" fill="white" opacity="0.9"/><rect x="8" y="3" width="13" height="18" rx="2" fill="white" opacity="0.6"/><rect x="4" y="7" width="7" height="1.5" rx="0.75" fill="#1a3a5c"/><rect x="4" y="10" width="9" height="1.5" rx="0.75" fill="#1a3a5c"/><rect x="4" y="13" width="6" height="1.5" rx="0.75" fill="#1a3a5c"/></svg>`;
    }
  });

  // Desktop Sidebar Logo
  const sidebarLogos = document.querySelectorAll('.sidebar-brand-icon');
  sidebarLogos.forEach(logoWrap => {
    if (url) {
      logoWrap.style.background = 'none';
      // Use fixed 32px size here because the parent icon container uses font-size rather than fixed block dimensions
      logoWrap.innerHTML = `<img src="${url}" style="width:32px;height:32px;object-fit:cover;border-radius:50%;display:block;">`;
    } else {
      logoWrap.style.background = 'linear-gradient(135deg,var(--teal-dim),var(--teal))';
      logoWrap.innerHTML = `📚`;
    }
  });

  // Auth Screen Logo
  const authLogos = document.querySelectorAll('.auth-logo');
  authLogos.forEach(logoWrap => {
    if (url) {
      logoWrap.style.background = 'none';
      logoWrap.style.border = '1px solid var(--border)';
      logoWrap.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`;
    } else {
      logoWrap.style.background = 'linear-gradient(135deg,#4f46e5,#6366f1)';
      logoWrap.style.border = 'none';
      logoWrap.innerHTML = `📚`;
    }
  });
}


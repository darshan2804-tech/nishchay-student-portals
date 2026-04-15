// ============================================================
//  app.js  –  Main Orchestrator (ES6 Module entry point)
//  Wires auth, db, ui and core-engine together.
//  All window.* assignments expose functions to HTML onclick.
// ============================================================

import { FIREBASE_CONFIG, calcDates, toLocalDate, p, getTodayItems, detectSubject } from './core-engine.js';
import { initAuth, showAuthTab, forgotPassword, doLogin, doAdminLogin, doRegister, checkApproval, doLogout } from './auth.js';
import { listenToEntries, stopListening, saveEntry, deleteEntry, saveDoneKeys, getDoneKeys,
         saveExamDates, getExamDates, saveStudyTarget, getStudyTarget,
         saveStudyTime, getStudyTime, savePushSubscription, saveMistake,
         getMistakes, deleteMistake, saveMockScore, getMockScores, listenToSiteSettings } from './db.js';
import { showScreen, showToast, showAuthMsg, switchTab, updateClock, syncInputTime,
         renderUserInfo, updateTodayBadge, renderToday, renderLog, renderDashboard,
         renderCountdown, showResult, updateNotifToggle, applyTheme,
         renderPerformanceScore, renderStreak, applyGlobalLogo } from './ui.js';

// Optimistically inject cached logo instantly for the auth screen
const cachedLogo = localStorage.getItem('site_logo');
if (cachedLogo) {
  applyGlobalLogo(cachedLogo);
}

// Study Calendar Standalone URL
const CALENDAR_URL = 'https://study-calendar-standalone.vercel.app';

// ── Firebase init ─────────────────────────────────────────────
if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
const auth = firebase.auth();
const db   = firebase.firestore();

// ── App state ─────────────────────────────────────────────────
let currentUser  = null;
let entries      = [];
let doneSet      = new Set();
let examDates    = {};
let searchQuery  = '';
let pendingEntry = null;
let _gcEntry     = null;
let _gcRevs      = null;
let _stopListen  = null;
let isDark       = false;

// ─────────────────────────────────────────────────────────────
//  INIT APP
// ─────────────────────────────────────────────────────────────
async function initApp(user) {
  currentUser = user;
  showScreen('appScreen');
  renderUserInfo(user);

  // Theme (only UI preference — stored in one localStorage key)
  isDark = (localStorage.getItem('theme') === 'dark');
  applyTheme(isDark);

  // Clock
  updateClock(); syncInputTime();
  setInterval(updateClock, 1000);
  setInterval(syncInputTime, 60000);

  // Load exam dates from Firestore
  examDates = await getExamDates(db, user.uid);

  // Platform Site Settings Listener (Logo)
  listenToSiteSettings(db, data => applyGlobalLogo(data.logoUrl));

  // Daily done-set from Firestore
  const today = toLocalDate(new Date());
  doneSet     = await getDoneKeys(db, user.uid, today);

  // Start real-time entries listener (SSOT)
  if (_stopListen) _stopListen();
  _stopListen = listenToEntries(db, user.uid, updatedEntries => {
    entries = updatedEntries;
    updateTodayBadge(entries, doneSet);
  }, () => showToast('⚠️ Connection issue. Check your network.'));

  // Service Worker
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  // Notification toggle UI
  updateNotifToggle();

  // Study target + tools
  const tgt = await getStudyTarget(db, user.uid);
  _studyTargetHrs = tgt;

  const todayStr = toLocalDate(new Date());
  const timeData = await getStudyTime(db, user.uid, todayStr);
  _studyTimeData  = timeData;
  updTgt();

  // Attach sidebar toggle
  const sidebarToggle = document.getElementById('sidebarToggle');
  if (sidebarToggle) sidebarToggle.addEventListener('click', toggleSidebar);
}

function clearState() {
  currentUser  = null;
  entries      = [];
  doneSet      = new Set();
  examDates    = {};
  pendingEntry = null;
  if (_stopListen) { _stopListen(); _stopListen = null; }
  stopListening();
}

// ─────────────────────────────────────────────────────────────
//  AUTH WIRING
// ─────────────────────────────────────────────────────────────
initAuth(auth, db, {
  onApproved:  user => initApp(user),
  onPending:   ()   => showScreen('pendingScreen'),
  onLoggedOut: ()   => showScreen('authScreen')
});

// ─────────────────────────────────────────────────────────────
//  SIDEBAR
// ─────────────────────────────────────────────────────────────
function toggleSidebar() {
  document.querySelector('.sidebar')?.classList.toggle('collapsed');
}
window.toggleSidebar = toggleSidebar;

// ─────────────────────────────────────────────────────────────
//  TAB SWITCHING
// ─────────────────────────────────────────────────────────────
const renderCBs = {
  today:  () => { renderToday(entries, doneSet, toggleDone); document.getElementById('resetDoneBtn')?.addEventListener('click', resetDone); },
  log:    () => renderLog(entries, doneSet, searchQuery, reOpen, deleteEntryHandler),
  dash:   () => renderDashboard(entries, doneSet, examDates),
  backup: () => updateLastBackupInfo()
};
window.switchTab = name => switchTab(name, renderCBs);

// ─────────────────────────────────────────────────────────────
//  ADD ENTRY
// ─────────────────────────────────────────────────────────────
async function addEntry() {
  const topic   = (document.getElementById('topicInput')?.value || '').trim();
  const dateStr = document.getElementById('studyDate')?.value;
  const timeStr = document.getElementById('studyTime')?.value;
  if (!topic) { showToast('Please enter a topic!'); return; }
  const revisions = calcDates(dateStr, timeStr);
  pendingEntry    = {
    id: Date.now(), topic, dateStr, timeStr,
    subject: detectSubject(topic),
    revisions: revisions.map(r => ({ ...r, datetime: r.datetime.toISOString() }))
  };
  showResult(pendingEntry, revisions);
  _gcEntry = pendingEntry; _gcRevs = revisions;
  document.getElementById('topicInput').value = '';
  setTimeout(() => {
    document.getElementById('resultCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const btn = document.getElementById('saveEntryBtn');
    if (btn) { btn.innerHTML = '✅ Confirm & Save to Cloud'; btn.style.background = 'linear-gradient(135deg,#166534,#16a34a)'; btn.disabled = false; }
  }, 120);
  showToast('Preview ready! Tap "Save to Cloud" to confirm.');
}
window.addEntry = addEntry;

// ── Confirm save → saves to Firestore then opens Calendar app ─
window.savePendingEntry = async function () {
  if (!pendingEntry) return;
  const btn = document.getElementById('saveEntryBtn');
  try {
    btn.innerHTML = '⏳ Saving…'; btn.disabled = true;
    entries.unshift(pendingEntry);
    await saveEntry(db, currentUser.uid, pendingEntry);
    updateTodayBadge(entries, doneSet);
    btn.innerHTML = '✅ Saved! Opening Calendar…';
    btn.style.background = 'linear-gradient(135deg,#059669,#10b981)';
    showToast('✅ Saved to cloud! Opening Study Calendar…');
    pendingEntry = null;
    // Open the standalone Study Calendar so the user sees the events
    setTimeout(() => window.open(CALENDAR_URL, '_blank'), 600);
    setTimeout(() => {
      btn.innerHTML = '📅 Add to Calendar';
      btn.style.background = 'linear-gradient(135deg,#312e81,#4f46e5)';
      btn.disabled = false;
    }, 2000);
  } catch (e) {
    showToast('Error saving: ' + e.message);
    btn.disabled = false;
    btn.innerHTML = '📅 Add to Calendar';
    btn.style.background = 'linear-gradient(135deg,#312e81,#4f46e5)';
  }
};

// ─────────────────────────────────────────────────────────────
//  ICS FILE GENERATOR
// ─────────────────────────────────────────────────────────────

function generateICS(topic, revisions) {
  const now   = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Study Tracker//Nishchay Academy//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Study Revisions – ' + topic
  ];

  revisions.forEach((r, i) => {
    const dt    = r.datetime instanceof Date ? r.datetime : new Date(r.datetime);
    const start = dt.toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
    const end   = new Date(dt.getTime() + 30 * 60 * 1000)
                    .toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
    lines.push(
      'BEGIN:VEVENT',
      `UID:studytracker-${Date.now()}-${i}@nishchay`,
      `DTSTAMP:${now}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      `SUMMARY:\ud83d\udcda Revise: ${topic} [${r.label}]`,
      `DESCRIPTION:Spaced repetition – ${r.label}\\nTopic: ${topic}\\n\\nGenerated by Study Tracker – Nishchay Academy`,
      'CATEGORIES:Study,Revision',
      'BEGIN:VALARM',
      'TRIGGER:-PT10M',
      'ACTION:DISPLAY',
      `DESCRIPTION:Reminder: Revise "${topic}" in 10 minutes`,
      'END:VALARM',
      'END:VEVENT'
    );
  });

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

window.downloadICS = function () {
  if (!_gcEntry || !_gcRevs) {
    showToast('⚠️ Generate a schedule first, then download .ics');
    return;
  }
  const ics  = generateICS(_gcEntry.topic, _gcRevs);
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const safe = (_gcEntry.topic || 'revisions').replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 40);
  a.href = url;
  a.download = `study-revisions-${safe}.ics`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
  showToast('📥 .ics downloaded! Import it into Google / Apple Calendar.');
};

// ─────────────────────────────────────────────────────────────
//  LOG PAGE
// ─────────────────────────────────────────────────────────────
async function toggleDone(key) {
  const today = toLocalDate(new Date());
  if (doneSet.has(key)) doneSet.delete(key); else doneSet.add(key);
  await saveDoneKeys(db, currentUser.uid, today, [...doneSet]);
  renderToday(entries, doneSet, toggleDone);
  document.getElementById('resetDoneBtn')?.addEventListener('click', resetDone);
  updateTodayBadge(entries, doneSet);
}

async function resetDone() {
  doneSet = new Set();
  await saveDoneKeys(db, currentUser.uid, toLocalDate(new Date()), []);
  renderToday(entries, doneSet, toggleDone);
  updateTodayBadge(entries, doneSet);
  showToast('Checkboxes reset!');
}

window.bulkNotifyToday = async function () {
  const items = getTodayItems(entries, doneSet);
  if (!items.length) { showToast('Nothing scheduled for today!'); return; }
  if (!window.Notification) { showToast('Browser does not support notifications.'); return; }
  if (Notification.permission !== 'granted') {
    const perm = await Notification.requestPermission();
    updateNotifToggle();
    if (perm !== 'granted') { showToast('⚠️ Notification permission denied.'); return; }
  }
  items.forEach((item, idx) => {
    setTimeout(() => {
      try { new Notification(`Revise: ${item.topic}`, { body: `Due Now: ${item.label}`, icon: './icon-192.png', tag: item.key }); }
      catch (e) { console.error('Notification failed:', e); }
    }, idx * 150);
  });
  showToast(`🔔 ${items.length} alerts pushed!`);
};

// ─────────────────────────────────────────────────────────────
//  LOG PAGE
// ─────────────────────────────────────────────────────────────
function reOpen(id) {
  const entry = entries.find(e => String(e.id) === String(id)); if (!entry) return;
  const revisions = (entry.revisions || []).map(r => ({ ...r, datetime: new Date(r.datetime) }));
  _gcEntry = entry; _gcRevs = revisions;
  window.switchTab('add');
  setTimeout(() => { showResult(entry, revisions); document.getElementById('resultCard')?.scrollIntoView({ behavior: 'smooth' }); }, 200);
}

async function deleteEntryHandler(id) {
  if (!confirm('Remove this entry and all 7 revisions?')) return;
  entries = entries.filter(e => String(e.id) !== String(id));
  await deleteEntry(db, currentUser.uid, id);
  renderLog(entries, doneSet, searchQuery, reOpen, deleteEntryHandler);
  updateTodayBadge(entries, doneSet);
  showToast('Entry removed.');
}

window.filterLog = function () {
  searchQuery = document.getElementById('searchInput')?.value.toLowerCase().trim() || '';
  const cb = document.getElementById('searchClear'); if (cb) cb.style.display = searchQuery ? 'block' : 'none';
  renderLog(entries, doneSet, searchQuery, reOpen, deleteEntryHandler);
};
window.clearSearch = function () {
  const si = document.getElementById('searchInput'); if (si) si.value = '';
  searchQuery = '';
  const cb = document.getElementById('searchClear'); if (cb) cb.style.display = 'none';
  renderLog(entries, doneSet, searchQuery, reOpen, deleteEntryHandler);
};

// ─────────────────────────────────────────────────────────────
//  DASHBOARD – EXAM DATES
// ─────────────────────────────────────────────────────────────
window.openExamModal  = () => {
  const m = document.getElementById('examModal'); if (!m) return;
  const md = document.getElementById('mainDate'); if (md && examDates.mains) md.value = examDates.mains;
  const ad = document.getElementById('advDate');  if (ad && examDates.adv)   ad.value = examDates.adv;
  m.classList.add('show');
};
window.closeExamModal = () => document.getElementById('examModal')?.classList.remove('show');
window.saveExamDatesHandler = async () => {
  const mains = document.getElementById('mainDate')?.value;
  const adv   = document.getElementById('advDate')?.value;
  examDates   = { mains, adv };
  await saveExamDates(db, currentUser.uid, examDates);
  window.closeExamModal();
  renderCountdown(examDates);
  showToast('Exam dates saved!');
};

// ─────────────────────────────────────────────────────────────
//  PUSH NOTIFICATIONS
// ─────────────────────────────────────────────────────────────
window.toggleNativeNotifications = async function () {
  const toggle = document.getElementById('notifToggle');
  if (!window.Notification) { showToast('Push not supported on this browser.'); if (toggle) toggle.checked = false; return; }
  if (Notification.permission === 'denied') {
    showToast('Notifications blocked. Enable in browser/OS settings.'); if (toggle) toggle.checked = false; return;
  }
  if (Notification.permission === 'granted') {
    updateNotifToggle();
    scheduleRevisionNotifications();
    showToast('✅ Reminders active! You\'ll get notified for revisions.');
    return;
  }
  const result = await Notification.requestPermission();
  updateNotifToggle();
  if (result === 'granted') {
    if (currentUser) await savePushSubscription(db, currentUser.uid, 'browser-native');
    scheduleRevisionNotifications();
    showToast('✅ Reminders enabled!');
    setTimeout(() => new Notification('Study Tracker', { body: '🎉 Notifications working! You\'ll be reminded for revisions.', icon: '/icon-192.png' }), 500);
  } else {
    showToast('Notification permission denied.');
  }
};

function scheduleRevisionNotifications() {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const items = getTodayItems(entries, doneSet);
  const now   = new Date();
  items.forEach(item => {
    const delay = new Date(item.datetime).getTime() - now.getTime();
    if (delay > 0 && delay < 24 * 60 * 60 * 1000) {
      setTimeout(() => new Notification('📚 Time to Revise!', { body: `[${item.label}] ${item.topic}`, icon: '/icon-192.png', tag: item.key }), delay);
    }
  });
}

// ─────────────────────────────────────────────────────────────
//  THEME
// ─────────────────────────────────────────────────────────────
window.toggleTheme = function () {
  isDark = !isDark;
  applyTheme(isDark);
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
};

// ─────────────────────────────────────────────────────────────
//  BACKUP / EXPORT
// ─────────────────────────────────────────────────────────────
window.exportData = function () {
  if (!entries.length) { showToast('No data to export!'); return; }
  const backup = { version: '3.0', exportDate: new Date().toISOString(), appName: 'Study Tracker', user: currentUser?.email, totalEntries: entries.length, entries };
  const blob   = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement('a');
  const ds     = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-');
  a.href = url; a.download = `studytracker-backup-${ds}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  updateLastBackupInfo();
  showToast(`✅ Backup saved! ${entries.length} entries exported.`);
};

document.addEventListener('DOMContentLoaded', () => {
  const fi = document.getElementById('importFileInput');
  if (fi) fi.onchange = function (e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async function (ev) {
      try {
        const backup = JSON.parse(ev.target.result);
        if (!backup.entries || !Array.isArray(backup.entries)) { showToast('Invalid backup file!'); return; }
        if (!confirm(`Import ${backup.entries.length} entries? This will ADD them to your current data.`)) return;
        let count = 0;
        for (const entry of backup.entries) {
          try { await saveEntry(db, currentUser.uid, entry); count++; } catch (e2) { /* skip */ }
        }
        showToast(`✅ Imported ${count} entries!`);
        window.switchTab('log');
      } catch (err) { showToast('Could not read file.'); }
    };
    reader.readAsText(file); this.value = '';
  };
});

function updateLastBackupInfo() {
  const el = document.getElementById('lastBackupInfo');
  if (el) el.textContent = `Exported on: ${new Date().toLocaleString('en-IN')} · Data lives in Firestore cloud.`;
}

// ─────────────────────────────────────────────────────────────
//  DAILY STUDY TARGET
// ─────────────────────────────────────────────────────────────
let _studyTargetHrs = 6;
let _studyTimeData  = {};
let _selectedTgt    = 6;

function updTgt() {
  const el = document.getElementById('tgtCur');   if (!el) return;
  const c  = Object.values(_studyTimeData).reduce((a, b) => a + b, 0);
  const p  = Math.min((c / _studyTargetHrs) * 100, 100);
  el.textContent = c.toFixed(1);
  const gEl = document.getElementById('tgtGoal'); if (gEl) gEl.textContent = _studyTargetHrs;
  const bar = document.getElementById('tgtBar');
  const msg = document.getElementById('tgtMsg');
  if (bar) bar.style.width = `${p}%`;
  if (c >= _studyTargetHrs) {
    if (bar) bar.style.background = 'linear-gradient(90deg,#16a34a,#22c55e)';
    if (msg) { msg.textContent = '🎉 Target complete!'; msg.style.color = '#16a34a'; }
  } else {
    if (bar) bar.style.background = 'linear-gradient(90deg,#d97706,#f59e0b)';
    if (msg) { msg.textContent = `${(_studyTargetHrs - c).toFixed(1)} hours remaining`; msg.style.color = 'var(--text-dim)'; }
  }
}

window.openTgtModal = function () {
  _selectedTgt = _studyTargetHrs;
  document.querySelectorAll('#_to [data-h]').forEach(el => {
    const h = parseFloat(el.dataset.h);
    el.style.background = h === _studyTargetHrs ? '#fef3c7' : '#f1f5f9';
    el.style.border = h === _studyTargetHrs ? '1.5px solid #d97706' : '1.5px solid #cbd5e1';
  });
  const m = document.getElementById('_tm'); if (m) m.style.display = 'flex';
};
window.closeTgtModal = function () { const m = document.getElementById('_tm'); if (m) m.style.display = 'none'; };
window.pickTgt = function (h) {
  _selectedTgt = h;
  document.querySelectorAll('#_to [data-h]').forEach(el => {
    const dh = parseFloat(el.dataset.h);
    el.style.background = dh === h ? '#fef3c7' : '#f1f5f9';
    el.style.border = dh === h ? '1.5px solid #d97706' : '1.5px solid #cbd5e1';
  });
};
window.saveTgt = async function () {
  _studyTargetHrs = _selectedTgt;
  if (currentUser) await saveStudyTarget(db, currentUser.uid, _studyTargetHrs);
  window.closeTgtModal(); updTgt(); showToast(`Target: ${_studyTargetHrs} hrs/day`);
};
window.logTgt = async function (subject, hours) {
  const today = toLocalDate(new Date());
  _studyTimeData[subject] = (_studyTimeData[subject] || 0) + hours;
  await saveStudyTime(db, currentUser.uid, today, _studyTimeData);
  updTgt();
  showToast(`+${hours >= 1 ? hours + 'hr' : hours * 60 + 'min'} ${subject}`);
};
window.addTime = window.logTgt;
window.resetTodayTime = async function () {
  _studyTimeData = {};
  const today = toLocalDate(new Date());
  await saveStudyTime(db, currentUser.uid, today, {});
  updTgt(); showToast('Study time reset!');
};

// ─────────────────────────────────────────────────────────────
//  USER MENU
// ─────────────────────────────────────────────────────────────
window.toggleUserMenu = function () { document.getElementById('userMenu')?.classList.toggle('show'); };
document.addEventListener('click', e => {
  const menu = document.getElementById('userMenu');
  if (menu?.classList.contains('show') && !e.target.closest('#userMenu') && !e.target.closest('#userAvatar')) menu.classList.remove('show');
});

// ─────────────────────────────────────────────────────────────
//  AUTH WINDOW BINDINGS
// ─────────────────────────────────────────────────────────────
window.showAuthTab       = tab              => showAuthTab(tab);
window.forgotPassword    = ()               => forgotPassword(auth);
window.doLogin           = ()               => doLogin(auth);
window.doAdminLogin      = ()               => doAdminLogin(auth);
window.doRegister        = ()               => doRegister(auth, db);
window.checkApproval     = ()               => checkApproval(auth, db, currentUser, initApp);
window.doLogout          = ()               => doLogout(auth, clearState);

// ─────────────────────────────────────────────────────────────
//  MISTAKE NOTEBOOK
// ─────────────────────────────────────────────────────────────
let _mistakes = [], _mistakeFilter = 'all';

window.openMistakeForm = function () {
  const modal = document.getElementById('mistakeModal'); if (!modal) return;
  modal.classList.add('show');
};
window.closeMistakeModal = function () { document.getElementById('mistakeModal')?.classList.remove('show'); };
window.saveMistakeHandler = async function () {
  const t = document.getElementById('mTopicInput')?.value.trim();
  const s = document.getElementById('mSubjectSel')?.value;
  const r = document.getElementById('mReasonInput')?.value.trim();
  if (!t) { showToast('Please enter the topic.'); return; }
  await saveMistake(db, currentUser.uid, { topic: t, subject: s || 'Other', reason: r, date: toLocalDate(new Date()) });
  window.closeMistakeModal();
  _mistakes = await getMistakes(db, currentUser.uid);
  renderMistakeList(_mistakes, _mistakeFilter);
  showToast('Mistake logged!');
};
window.filterMistakes = function (f) {
  _mistakeFilter = f;
  ['all','Physics','Chemistry','Maths'].forEach(k => {
    const btn = document.getElementById(`mf-${k === 'all' ? 'all' : k.toLowerCase().slice(0,3)}`);
    if (btn) Object.assign(btn.style, k === f ? { background: 'var(--teal)', color: '#fff', border: 'none' } : { background: 'var(--surface2)', color: 'var(--text-muted)', border: '1px solid var(--border)' });
  });
  renderMistakeList(_mistakes, f);
};
window.deleteMistakeHandler = async function (id) {
  await deleteMistake(db, currentUser.uid, id);
  _mistakes = _mistakes.filter(m => m.id !== id);
  renderMistakeList(_mistakes, _mistakeFilter);
};
function renderMistakeList(list, filter) {
  const c = document.getElementById('mistakeList'); if (!c) return;
  const filtered = filter === 'all' ? list : list.filter(m => m.subject === filter);
  if (!filtered.length) { c.innerHTML = '<div class="empty-state"><span class="emoji">📕</span><p>No mistakes logged yet.</p></div>'; return; }
  c.innerHTML = filtered.map(m => `<div class="mistake-item">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div><div class="mistake-topic">${m.topic}</div><div class="mistake-meta">${m.subject} · ${m.date||''}</div>${m.reason ? `<div class="mistake-reason">${m.reason}</div>` : ''}</div>
      <button onclick="window.deleteMistakeHandler('${m.id}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:0.85rem;">✕</button>
    </div></div>`).join('');
}

// ─────────────────────────────────────────────────────────────
//  MOCK SCORES
// ─────────────────────────────────────────────────────────────
let _mockScores = [];

window.openMockForm = function () { document.getElementById('mockModal')?.classList.add('show'); };
window.closeMockModal = function () { document.getElementById('mockModal')?.classList.remove('show'); };
window.saveMockHandler = async function () {
  const score = parseFloat(document.getElementById('mScore')?.value);
  const total = parseFloat(document.getElementById('mTotal')?.value || '300');
  const name  = (document.getElementById('mTestName')?.value || '').trim();
  if (isNaN(score)) { showToast('Please enter a score.'); return; }
  await saveMockScore(db, currentUser.uid, { score, total, name: name || 'Mock Test', date: toLocalDate(new Date()) });
  window.closeMockModal();
  _mockScores = await getMockScores(db, currentUser.uid);
  renderMockList();
  showToast('Score saved!');
};
function renderMockList() {
  const c = document.getElementById('mockList'); if (!c) return;
  if (!_mockScores.length) { c.innerHTML = '<div class="empty-state"><span class="emoji">📝</span><p>No mock tests logged yet.</p></div>'; return; }
  c.innerHTML = _mockScores.slice(0, 10).map(m => {
    const pct = Math.round(m.score / m.total * 100);
    const cls = pct >= 80 ? 'background:#dcfce7;color:#16a34a' : pct >= 60 ? 'background:#fef3c7;color:#d97706' : 'background:#fee2e2;color:#dc2626';
    return `<div class="mock-item">
      <div class="mock-score">${m.score}<span style="font-size:0.7rem;opacity:0.6">/${m.total}</span></div>
      <div class="mock-detail">${m.name || 'Mock'} · ${m.date || ''}</div>
      <span class="mock-badge" style="${cls}">${pct}%</span>
    </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────
//  POMODORO TIMER
// ─────────────────────────────────────────────────────────────
let _pomoMode = 25, _pomoLabel = 'Focus', _pomoLeft = 25 * 60, _pomoRunning = false, _pomoInterval = null, _pomoSessions = 0;

window.setPomoMode = function (mins, label) {
  if (_pomoRunning) return;
  _pomoMode = mins; _pomoLabel = label; _pomoLeft = mins * 60;
  updatePomoUI();
  ['25','50','5'].forEach(m => {
    const btn = document.getElementById(`pomo-${m}`);
    if (btn) Object.assign(btn.style, String(mins) === m ? { background: 'var(--teal)', color: '#fff', border: 'none' } : { background: 'var(--surface2)', color: 'var(--text-muted)', border: '1px solid var(--border)' });
  });
};
window.startPomo = function () {
  const btn = document.getElementById('pomoStartBtn');
  if (_pomoRunning) {
    clearInterval(_pomoInterval); _pomoRunning = false;
    if (btn) btn.innerHTML = '▶ Start'; return;
  }
  _pomoRunning = true; if (btn) btn.innerHTML = '⏸ Pause';
  _pomoInterval = setInterval(() => {
    _pomoLeft--;
    updatePomoUI();
    if (_pomoLeft <= 0) {
      clearInterval(_pomoInterval); _pomoRunning = false;
      if (btn) btn.innerHTML = '▶ Start';
      if (_pomoLabel === 'Focus') {
        _pomoSessions++;
        const se = document.getElementById('pomoSessions'); if (se) se.textContent = `${_pomoSessions} sessions today`;
        const subj = document.getElementById('pomoSubject')?.value || 'Physics';
        window.logTgt(subj, _pomoMode / 60);
        if (Notification.permission === 'granted') new Notification('🍅 Pomodoro Done!', { body: 'Great focus session! Take a break.', icon: '/icon-192.png' });
        else showToast('🍅 Pomodoro complete!');
        window.setPomoMode(5, 'Break');
      } else {
        showToast('☕ Break over! Ready to focus?');
        window.setPomoMode(25, 'Focus');
      }
    }
  }, 1000);
};
window.resetPomo = function () {
  clearInterval(_pomoInterval); _pomoRunning = false;
  _pomoLeft = _pomoMode * 60; updatePomoUI();
  const btn = document.getElementById('pomoStartBtn'); if (btn) btn.innerHTML = '▶ Start';
};
function updatePomoUI() {
  const mins = Math.floor(_pomoLeft / 60), secs = _pomoLeft % 60;
  const te = document.getElementById('pomoTime'); if (te) te.textContent = `${p(mins)}:${p(secs)}`;
  const le = document.getElementById('pomoLabel'); if (le) le.textContent = _pomoLabel;
  const total = _pomoMode * 60;
  const circ  = document.getElementById('pomoCircle');
  if (circ) circ.style.strokeDashoffset = 377 * (1 - _pomoLeft / total);
}

// ─────────────────────────────────────────────────────────────
//  QUESTIONS TRACKER
// ─────────────────────────────────────────────────────────────
const _qCounts = { Physics: 0, Chemistry: 0, Maths: 0 };
window.addQ = function (subject, n) {
  _qCounts[subject] = (_qCounts[subject] || 0) + n;
  const map = { Physics: 'qa-phy', Chemistry: 'qa-chem', Maths: 'qa-math' };
  const el = document.getElementById(map[subject]); if (el) el.textContent = _qCounts[subject];
  const total = Object.values(_qCounts).reduce((a, b) => a + b, 0);
  const tot = document.getElementById('qa-total'); if (tot) tot.textContent = total;
  showToast(`+${n} ${subject} questions`);
};

// ─────────────────────────────────────────────────────────────
//  FORMULA QUICK-REF (offline, static data)
// ─────────────────────────────────────────────────────────────
const FORMULAS = {
  Physics: [
    { section: 'Kinematics', items: [{ name: 'Velocity',    eq: 'v = u + at',           note: 'u=initial, a=acceleration' },{ name: 'Displacement', eq: 's = ut + ½at²',        note: '' },{ name: 'v²',          eq: 'v² = u² + 2as',        note: '' }] },
    { section: 'Newton\'s Laws', items: [{ name: 'Force', eq: 'F = ma', note: 'Newton\'s 2nd law' },{ name: 'Momentum', eq: 'p = mv', note: '' }] },
    { section: 'Energy',     items: [{ name: 'KE', eq: 'KE = ½mv²', note: '' },{ name: 'PE', eq: 'PE = mgh', note: '' },{ name: 'Work', eq: 'W = Fs·cosθ', note: '' }] }
  ],
  Chemistry: [
    { section: 'Mole Concept', items: [{ name: 'Moles', eq: 'n = m/M', note: 'm=mass, M=molar mass' },{ name: 'Avogadro', eq: 'N = n × 6.022×10²³', note: '' }] },
    { section: 'Ideal Gas',    items: [{ name: 'PVT', eq: 'PV = nRT', note: 'R = 8.314 J/mol·K' }] }
  ],
  Maths: [
    { section: 'Algebra',      items: [{ name: 'Quadratic', eq: 'x = (-b ± √(b²-4ac))/2a', note: 'Discriminant: D=b²-4ac' }] },
    { section: 'Calculus',     items: [{ name: 'Chain Rule', eq: 'd/dx[f(g(x))] = f\'(g)·g\'', note: '' },{ name: 'Product',   eq: 'd/dx[uv] = u\'v + uv\'', note: '' }] },
    { section: 'Trigonometry', items: [{ name: 'sin²+cos²', eq: 'sin²θ + cos²θ = 1', note: '' },{ name: 'Double Angle', eq: 'sin 2θ = 2 sinθ cosθ', note: '' }] }
  ]
};
window.showFormulas = function (subject) {
  ['Physics','Chemistry','Maths'].forEach(s => {
    const id = s === 'Physics' ? 'ff-phy' : s === 'Chemistry' ? 'ff-chem' : 'ff-math';
    const btn = document.getElementById(id);
    if (btn) Object.assign(btn.style, s === subject ? { background: 'var(--teal)', color: '#fff', border: 'none' } : { background: 'var(--surface2)', color: 'var(--text-muted)', border: '1px solid var(--border)' });
  });
  const c = document.getElementById('formulaList'); if (!c) return;
  const data = FORMULAS[subject] || [];
  c.innerHTML = data.map(section => `
    <div class="formula-section">
      <div class="formula-section-title">${section.section}</div>
      <div class="formula-items">${section.items.map(it => `
        <div class="formula-card">
          <div class="formula-name">${it.name}</div>
          <div class="formula-eq">${it.eq}</div>
          ${it.note ? `<div class="formula-note">${it.note}</div>` : ''}
        </div>`).join('')}
      </div>
    </div>`).join('');
};

// ─────────────────────────────────────────────────────────────
//  BUS FLASHCARDS (derived from your topics)
// ─────────────────────────────────────────────────────────────
let _flashCards = [], _flashIdx = 0, _flashFlipped = false;
window.startFlash = function (subject) {
  const filtered = entries.filter(e => detectSubject(e.topic) === subject);
  _flashCards = filtered.map(e => ({ q: e.topic, a: `Studied: ${e.dateStr}  |  7 revisions scheduled` }));
  _flashIdx   = 0; _flashFlipped = false;
  if (!_flashCards.length) { showToast(`No ${subject} topics logged yet!`); return; }
  showFlashCard();
  const fc = document.getElementById('flashCard');    if (fc)   fc.style.display = 'block';
  const fn = document.getElementById('flashNav');     if (fn)   fn.style.display = 'block';
  const fe = document.getElementById('flashEmpty');   if (fe)   fe.style.display = 'none';
};
window.flipFlash = function () {
  _flashFlipped = !_flashFlipped;
  const front = document.getElementById('flashFront');
  const back  = document.getElementById('flashBack');
  if (front) front.style.display = _flashFlipped ? 'none' : 'block';
  if (back)  back.style.display  = _flashFlipped ? 'block' : 'none';
};
window.nextFlash = function () { _flashIdx = (_flashIdx + 1) % _flashCards.length; _flashFlipped = false; showFlashCard(); };
window.prevFlash = function () { _flashIdx = (_flashIdx - 1 + _flashCards.length) % _flashCards.length; _flashFlipped = false; showFlashCard(); };
function showFlashCard() {
  const card  = _flashCards[_flashIdx];
  const fq    = document.getElementById('flashQ');     if (fq)    fq.textContent = card.q;
  const fa    = document.getElementById('flashA');     if (fa)    fa.textContent = card.a;
  const fc    = document.getElementById('flashCount'); if (fc)    fc.textContent = `${_flashIdx + 1} / ${_flashCards.length}`;
  const front = document.getElementById('flashFront'); if (front) front.style.display = 'block';
  const back  = document.getElementById('flashBack');  if (back)  back.style.display  = 'none';
}

// ─────────────────────────────────────────────────────────────
//  TARGET MODAL (created dynamically if not in HTML)
// ─────────────────────────────────────────────────────────────
(function () {
  if (document.getElementById('_tm')) return;
  const m = document.createElement('div');
  m.id = '_tm';
  m.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:6001;align-items:center;justify-content:center;padding:20px;';
  m.innerHTML = `<div style="background:var(--surface,#fff);border-radius:20px;padding:24px;width:100%;max-width:320px;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
    <div style="font-family:Poppins,sans-serif;font-size:1rem;font-weight:700;margin-bottom:12px;color:var(--text);">Set Daily Study Target</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px;" id="_to">
      ${[4,5,6,7,8,10].map(h => `<div onclick="window.pickTgt(${h})" data-h="${h}" style="background:#f1f5f9;border:1.5px solid #cbd5e1;border-radius:10px;padding:10px 4px;text-align:center;cursor:pointer;"><div style="font-family:Poppins,sans-serif;font-size:1.3rem;font-weight:700;color:#d97706;">${h}</div><div style="font-size:0.55rem;color:#94a3b8;">hours</div></div>`).join('')}
    </div>
    <div style="display:flex;gap:10px;">
      <button onclick="window.closeTgtModal()" style="flex:1;background:#f1f5f9;border:1px solid #cbd5e1;color:#475569;border-radius:10px;padding:12px;cursor:pointer;">Cancel</button>
      <button onclick="window.saveTgt()" style="flex:2;background:linear-gradient(135deg,#d97706,#f59e0b);color:#fff;border:none;border-radius:10px;padding:12px;font-family:Poppins,sans-serif;font-weight:700;cursor:pointer;">Save</button>
    </div>
  </div>`;
  document.body.appendChild(m);
})();

// ─────────────────────────────────────────────────────────────
//  EMAIL REPORT
// ─────────────────────────────────────────────────────────────
window.downloadPDFReport = function () {
  if (!entries.length) { showToast('No data yet!'); return; }
  const { score, done, pending, label } = calcPerformanceScore(entries, doneSet);
  const { current: cur, longest, total } = calcStreak(entries);
  const userName  = currentUser?.displayName || currentUser?.email?.split('@')[0] || 'Student';
  const dateStr   = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const win       = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Study Tracker Report</title>
    <style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Inter,sans-serif;background:#f8f9fc;color:#0f172a;padding:30px;}
    .header{background:linear-gradient(135deg,#4f46e5,#6366f1);border-radius:16px;padding:28px;color:#fff;text-align:center;margin-bottom:24px;}
    .grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px;}
    .card{background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 6px rgba(0,0,0,0.08);}
    .big-num{font-size:2.5rem;font-weight:800;color:#4f46e5;}
    @media print{button{display:none!important}}</style></head><body>
    <div class="header"><h1>📚 Study Tracker</h1><p>${userName} · ${dateStr}</p></div>
    <div class="grid4">
      <div class="card"><h3>Topics</h3><div class="big-num">${entries.length}</div></div>
      <div class="card"><h3>Score</h3><div class="big-num">${score}%</div><p style="font-size:0.75rem;color:#64748b;margin-top:4px">${label}</p></div>
      <div class="card"><h3>Streak</h3><div class="big-num">${cur}</div><p style="font-size:0.75rem;color:#64748b">days</p></div>
      <div class="card"><h3>Best</h3><div class="big-num">${longest}</div><p style="font-size:0.75rem;color:#64748b">streak days</p></div>
    </div>
    <div class="card" style="margin-bottom:24px;"><h3 style="margin-bottom:12px;">All Topics</h3>
    ${entries.map((e, i) => `<div style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:0.88rem;">#${i+1} ${e.topic} <span style="color:#94a3b8;font-size:0.75rem">· ${e.dateStr}</span></div>`).join('')}</div>
    <div style="text-align:center;margin-top:20px;">
      <button onclick="window.print()" style="background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff;border:none;border-radius:10px;padding:14px 32px;font-size:0.9rem;font-weight:700;cursor:pointer;">🖨️ Save as PDF</button>
    </div></body></html>`);
  win.document.close();
};

window.sendEmailReport = async function () {
  const email = document.getElementById('reportEmail')?.value.trim();
  if (!email || !email.includes('@')) { document.getElementById('emailReportMsg').innerHTML = '<span style="color:#dc2626;">Please enter a valid email.</span>'; return; }
  if (!entries.length) { showToast('No data yet!'); return; }
  const btn = document.getElementById('sendEmailBtn'); btn.disabled = true; btn.innerHTML = '<span class="btn-spinner"></span>Sending…';
  try {
    const { score } = calcPerformanceScore(entries, doneSet);
    const { current } = calcStreak(entries);
    const name = currentUser?.displayName || 'Student';
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 
        'accept': 'application/json', 
        'api-key': 'YOUR_BREVO_API_KEY_HERE', 
        'content-type': 'application/json' 
      },
      body: JSON.stringify({ 
        sender: { name: 'Study Tracker', email: 'darshanderkar20@gmail.com' }, 
        to: [{ email, name }], 
        subject: `📚 Study Tracker Report - ${new Date().toLocaleDateString('en-IN')}`, 
        htmlContent: `<p>Hi ${name}!<br>Your score: <b>${score}%</b><br>Streak: <b>${current} days</b><br>Topics: <b>${entries.length}</b></p><a href="https://study-five-umber.vercel.app">Open Study Tracker</a>` 
      })
    });
    if (res.ok) { document.getElementById('emailReportMsg').innerHTML = '<span style="color:#16a34a;">✅ Report sent!</span>'; showToast('📧 Report sent!'); }
    else throw new Error('Brevo error ' + res.status);
  } catch (err) {
    document.getElementById('emailReportMsg').innerHTML = '<span style="color:#dc2626;">❌ Failed. Try again.</span>';
  }
  btn.disabled = false; btn.innerHTML = '📧 Send Report to My Email';
};

// ─────────────────────────────────────────────────────────────
//  FORMULA SECTION COLLAPSE
// ─────────────────────────────────────────────────────────────
document.addEventListener('click', e => {
  const title = e.target.closest('.formula-section-title');
  if (title) title.closest('.formula-section')?.classList.toggle('collapsed');
});

// ─────────────────────────────────────────────────────────────
//  INIT DEFAULT STATE
// ─────────────────────────────────────────────────────────────
showScreen('authScreen');
showAuthTab('login');
window.showFormulas('Physics');
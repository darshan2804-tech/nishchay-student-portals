// ═══════════════════════════════════════════════════════════════
// app.js — Cloud-Native Study Tracker v4.0
// Zero localStorage. Real-time Firestore. Modular Architecture.
// ═══════════════════════════════════════════════════════════════

// ── Config ────────────────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyBRw3GxukFyPEcjOY-0FIsXBk2p-7TQivM',
  authDomain:        'study-tracker-52de8.firebaseapp.com',
  projectId:         'study-tracker-52de8',
  storageBucket:     'study-tracker-52de8.firebasestorage.app',
  messagingSenderId: '183173939785',
  appId:             '1:183173939785:web:5fc5eee2f86b87c356b598'
};
const ADMIN_EMAILS = ['darshanderkar20@gmail.com', 'derkardarshan@gmail.com'];
const VAPID_KEY = 'BEEQx-o45PHXez8mhD8KZR1aISwH-yDt4bRZNLq1O8reA3dcWfgS1LvLRPHYX-wG0fkrhevh_PJ-G_QP5pi5GY';

// ── Firebase Init ──────────────────────────────────────────────
firebase.initializeApp(FIREBASE_CONFIG);
const _auth = firebase.auth();
const _db   = firebase.firestore();

// ── App State (SSOT — no localStorage) ────────────────────────
const App = {
  user:         null,
  entries:      [],
  dailyData:    {},   // { 'YYYY-MM-DD': { done:{key:true}, ratings:{key:'easy'}, hardRepeats:{key:true} } }
  studyTime:    {},   // { 'YYYY-MM-DD': { Physics:0, Chemistry:0, Maths:0 } }
  mistakes:     [],
  mocks:        [],
  examDates:    {},
  studyTarget:  6,
  searchQuery:  '',
  pendingEntry: null,
  _unsubs:      [],
};

// ── Helpers ───────────────────────────────────────────────────
const p          = n => String(n).padStart(2, '0');
const toLocalDate = d => d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
const todayStr   = () => toLocalDate(new Date());

// ══════════════════════════════════════════════════════════════
// MODULE: core-engine — Spaced Repetition & Streak Calculations
// ══════════════════════════════════════════════════════════════
const INTERVALS = [
  { label: '12 hrs', mins: 720,   type: 'short' },
  { label: 'Day 1',  mins: 1440,  type: 'long'  },
  { label: 'Day 2',  mins: 2880,  type: 'long'  },
  { label: 'Day 4',  mins: 5760,  type: 'long'  },
  { label: 'Day 7',  mins: 10080, type: 'long'  },
  { label: 'Day 15', mins: 21600, type: 'long'  },
  { label: 'Day 30', mins: 43200, type: 'long'  },
];

function calcDates(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, mi]   = (timeStr || '00:00').split(':').map(Number);
  const base = new Date(y, m - 1, d, h, mi, 0);
  return INTERVALS.map(iv => ({ ...iv, datetime: new Date(base.getTime() + iv.mins * 60000) }));
}

function calcStreak() {
  const studyDays = new Set(App.entries.map(e => e.dateStr));
  let current = 0, longest = 0, temp = 0;
  const today_ = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(today_); d.setDate(d.getDate() - i);
    if (studyDays.has(toLocalDate(d))) {
      temp++;
      if (i === 0 || i === 1) current = temp;
    } else {
      if (i <= 1) current = 0;
      longest = Math.max(longest, temp);
      temp = 0;
    }
  }
  return { current, longest: Math.max(longest, temp), total: studyDays.size };
}

function calcPerformanceScore() {
  if (!App.entries.length) return { score: 0, done: 0, pending: 0, label: 'Start studying!' };
  const today_ = new Date(); today_.setHours(0, 0, 0, 0);
  const allDone = new Set();
  Object.values(App.dailyData).forEach(day => Object.keys(day.done || {}).forEach(k => allDone.add(k)));
  let totalDue = 0, totalDone = 0;
  App.entries.forEach(entry => {
    entry.revisions.forEach(r => {
      const rDate = new Date(r.datetime); rDate.setHours(0, 0, 0, 0);
      if (rDate <= today_) {
        totalDue++;
        if (allDone.has(String(entry.id) + '_' + r.label)) totalDone++;
      }
    });
  });
  const score   = totalDue > 0 ? Math.round(totalDone / totalDue * 100) : 0;
  const pending = totalDue - totalDone;
  const label   = score >= 90 ? '🔥 Excellent!' : score >= 70 ? '✅ Good progress!' : score >= 50 ? '📈 Getting there!' : score >= 30 ? '💪 Keep pushing!' : '🚀 Just getting started!';
  return { score, done: totalDone, pending, label };
}

function classifySubject(topic) {
  const t = topic.toLowerCase();
  if (t.includes('phy') || t.includes('motion') || t.includes('force') || t.includes('energy') || t.includes('wave') || t.includes('optic') || t.includes('electric') || t.includes('magnet') || t.includes('thermo')) return 'Physics';
  if (t.includes('chem') || t.includes('organic') || t.includes('inorganic') || t.includes('acid') || t.includes('reaction') || t.includes('element') || t.includes('bond') || t.includes('mole')) return 'Chemistry';
  if (t.includes('math') || t.includes('calculus') || t.includes('algebra') || t.includes('trigon') || t.includes('coordinate') || t.includes('vector') || t.includes('matrix') || t.includes('integral') || t.includes('differenti') || t.includes('equation') || t.includes('quadratic')) return 'Maths';
  return 'Physics';
}

function getTodayItems() {
  const ts        = todayStr();
  const daily     = App.dailyData[ts] || {};
  const doneSet   = new Set(Object.keys(daily.done || {}));
  const items     = [];
  App.entries.forEach(entry => {
    entry.revisions.forEach(r => {
      if (toLocalDate(new Date(r.datetime)) === ts) {
        const key = String(entry.id) + '_' + r.label;
        items.push({ topic: entry.topic, label: r.label, datetime: r.datetime, key, done: doneSet.has(key) });
      }
    });
  });
  // Include hard-repeat items from Firestore
  Object.keys(daily.hardRepeats || {}).forEach(key => {
    if (!items.find(i => i.key === key)) {
      const entryId = key.split('_')[0];
      const entry = App.entries.find(e => String(e.id) === entryId);
      if (entry) items.push({ topic: entry.topic, label: '🔁 Repeat', datetime: new Date().toISOString(), key, done: doneSet.has(key) });
    }
  });
  return items.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
}

// ══════════════════════════════════════════════════════════════
// MODULE: db — Firestore CRUD & Real-Time Listeners
// ══════════════════════════════════════════════════════════════
function setupListeners(uid) {
  App._unsubs.forEach(fn => fn());
  App._unsubs = [];

  // 1. Real-time entries
  const unsubEntries = _db.collection('users').doc(uid).collection('entries')
    .orderBy('createdAt', 'desc')
    .onSnapshot(snap => {
      App.entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      updateTodayBadge();
      const active = document.querySelector('.page.active');
      if (!active) return;
      const name = active.id.replace('page-', '');
      if (name === 'today')    renderToday();
      if (name === 'log')      renderLog();
      if (name === 'dash')     renderDashboard();
      if (name === 'calendar') renderCalendar();
    }, err => console.error('[DB] Entries error:', err));
  App._unsubs.push(unsubEntries);

  // 2. Real-time today's done / ratings
  const ts = todayStr();
  const unsubToday = _db.collection('users').doc(uid).collection('daily').doc(ts)
    .onSnapshot(snap => {
      App.dailyData[ts] = snap.exists ? snap.data() : { done: {}, ratings: {} };
      updateTodayBadge();
      if (document.getElementById('page-today')?.classList.contains('active')) renderToday();
    });
  App._unsubs.push(unsubToday);
}

async function dbSaveEntry(uid, entry) {
  await _db.collection('users').doc(uid).collection('entries').doc(String(entry.id))
    .set({ ...entry, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
}

async function dbDeleteEntry(uid, id) {
  await _db.collection('users').doc(uid).collection('entries').doc(String(id)).delete();
}

async function dbToggleDone(uid, ts, key, isDone) {
  const ref = _db.collection('users').doc(uid).collection('daily').doc(ts);
  if (isDone) {
    await ref.set({ done: { [key]: firebase.firestore.FieldValue.delete() } }, { merge: true });
  } else {
    await ref.set({ done: { [key]: true } }, { merge: true });
  }
}

async function dbRateRevision(uid, ts, key, rating) {
  const ref = _db.collection('users').doc(uid).collection('daily').doc(ts);
  await ref.set({ done: { [key]: true }, ratings: { [key]: rating } }, { merge: true });
  if (rating === 'hard') {
    const tmr = new Date(); tmr.setDate(tmr.getDate() + 1);
    await _db.collection('users').doc(uid).collection('daily').doc(toLocalDate(tmr))
      .set({ hardRepeats: { [key]: true } }, { merge: true });
  }
}

async function dbSaveSettings(uid, type, data) {
  await _db.collection('users').doc(uid).collection('settings').doc(type).set(data);
}

async function dbLogStudyTime(uid, ts, subj, hrs) {
  await _db.collection('users').doc(uid).collection('studytime').doc(ts)
    .set({ [subj]: firebase.firestore.FieldValue.increment(hrs) }, { merge: true });
}

async function dbSaveData(uid, type, payload) {
  await _db.collection('users').doc(uid).collection('data').doc(type).set({ payload });
}

async function dbLoadData(uid, type) {
  try {
    const snap = await _db.collection('users').doc(uid).collection('data').doc(type).get();
    return snap.exists ? (snap.data().payload || []) : [];
  } catch(e) { return []; }
}

async function dbLoadStudyTime(uid, ts) {
  try {
    const snap = await _db.collection('users').doc(uid).collection('studytime').doc(ts).get();
    return snap.exists ? snap.data() : {};
  } catch(e) { return {}; }
}

// ══════════════════════════════════════════════════════════════
// MODULE: auth — Google OAuth & Whitelist Auth
// ══════════════════════════════════════════════════════════════
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  const nav = document.querySelector('.bottom-nav');
  if (nav) nav.style.display = (id === 'appScreen') ? 'flex' : 'none';
}

showScreen('authScreen');

_auth.onAuthStateChanged(async user => {
  if (!user) { showScreen('authScreen'); return; }
  App.user = user;
  if (ADMIN_EMAILS.includes(user.email)) {
    try { await _db.collection('users').doc(user.uid).set({ name: user.displayName || user.email.split('@')[0], email: user.email, status: 'approved', createdAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true }); } catch(e) {}
    initApp(user);
  } else {
    try {
      const doc = await _db.collection('users').doc(user.uid).get();
      if (!doc.exists) { await _auth.signOut(); showScreen('authScreen'); return; }
      const st = doc.data()?.status;
      if (st === 'approved') { applyTheme(doc.data()?.theme || 'light'); initApp(user); }
      else if (st === 'pending') showScreen('pendingScreen');
      else { await _auth.signOut(); showScreen('authScreen'); }
    } catch(e) { await _auth.signOut(); showScreen('authScreen'); }
  }
});

async function initApp(user) {
  showScreen('appScreen');
  const name = user.displayName || user.email || 'U';
  document.getElementById('userAvatar').textContent = name[0].toUpperCase();
  document.getElementById('menuName').textContent    = name;
  document.getElementById('menuEmail').textContent   = user.email;
  syncInputTime(); updateClock();
  setInterval(updateClock, 1000);
  setInterval(syncInputTime, 60000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  updateNotifUI();
  setupListeners(user.uid);
  // Load settings from Firestore
  try {
    const [ed, td] = await Promise.all([
      _db.collection('users').doc(user.uid).collection('settings').doc('examdates').get(),
      _db.collection('users').doc(user.uid).collection('settings').doc('studytarget').get()
    ]);
    if (ed.exists) App.examDates = ed.data();
    if (td.exists && td.data().hours) App.studyTarget = td.data().hours;
  } catch(e) {}
  // Load today's study time
  App.studyTime[todayStr()] = await dbLoadStudyTime(user.uid, todayStr());
  // Load mistakes & mocks
  App.mistakes = await dbLoadData(user.uid, 'mistakes');
  App.mocks    = await dbLoadData(user.uid, 'mocks');
}

// Auth UI functions
function showAuthTab(tab) {
  ['loginForm', 'registerForm', 'adminForm'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  const f = document.getElementById(tab + 'Form'); if (f) f.style.display = 'block';
}

function showAuthMsg(id, msg, type) {
  const el = document.getElementById(id); if (!el) return;
  el.textContent = msg;
  const s = { error: 'color:#dc2626;background:#fef2f2;border:1px solid #fecaca;', success: 'color:#16a34a;background:#f0fdf4;border:1px solid #bbf7d0;', info: 'color:#0284c7;background:#e0f2fe;border:1px solid #bae6fd;' };
  el.style.cssText = (s[type] || '') + 'border-radius:8px;padding:8px;text-align:center;font-size:0.75rem;font-weight:500;margin-top:10px;';
}

async function doLogin() {
  const email = document.getElementById('loginEmail')?.value.trim();
  const pass  = document.getElementById('loginPass')?.value;
  if (!email || !pass) { showAuthMsg('loginMsg', 'Fill all fields.', 'error'); return; }
  const btn = document.getElementById('loginBtn');
  if (btn) btn.disabled = true;
  try { await _auth.signInWithEmailAndPassword(email, pass); }
  catch(e) {
    let msg = 'Login failed.';
    if (e.code === 'auth/wrong-password' || e.code === 'auth/invalid-credential') msg = 'Wrong email or password.';
    if (e.code === 'auth/user-not-found') msg = 'No account found.';
    if (e.code === 'auth/too-many-requests') msg = 'Too many attempts. Try later.';
    showAuthMsg('loginMsg', msg, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Login to Study Tracker'; }
  }
}

async function doAdminLogin() {
  const email = document.getElementById('adminEmail')?.value.trim();
  const pass  = document.getElementById('adminPass')?.value;
  if (!ADMIN_EMAILS.includes(email)) { showAuthMsg('adminMsg', 'Not an admin email.', 'error'); return; }
  try { await _auth.signInWithEmailAndPassword(email, pass); }
  catch(e) { showAuthMsg('adminMsg', 'Login failed.', 'error'); }
}

async function doGoogleLogin() {
  const provider = new firebase.auth.GoogleAuthProvider();
  showAuthMsg('loginMsg', 'Opening Google login...', 'info');
  try {
    const cred = await _auth.signInWithPopup(provider);
    const doc  = await _db.collection('users').doc(cred.user.uid).get();
    if (!doc.exists) {
      await _db.collection('users').doc(cred.user.uid).set({ name: cred.user.displayName, email: cred.user.email, phone: '', status: 'pending', createdAt: firebase.firestore.FieldValue.serverTimestamp() });
      await _db.collection('requests').doc(cred.user.uid).set({ name: cred.user.displayName, email: cred.user.email, phone: '', status: 'pending', uid: cred.user.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
      showScreen('pendingScreen');
    }
  } catch(e) { showAuthMsg('loginMsg', 'Google login failed: ' + e.message, 'error'); }
}

async function doRegister() {
  const name  = document.getElementById('regName')?.value.trim();
  const email = document.getElementById('regEmail')?.value.trim();
  const phone = document.getElementById('regPhone')?.value.trim();
  const pass  = document.getElementById('regPass')?.value;
  if (!name || !email || !phone || !pass) { showAuthMsg('registerMsg', 'Fill all fields.', 'error'); return; }
  if (pass.length < 6) { showAuthMsg('registerMsg', 'Password must be 6+ chars.', 'error'); return; }
  try {
    const cred = await _auth.createUserWithEmailAndPassword(email, pass);
    await cred.user.updateProfile({ displayName: name });
    await _db.collection('users').doc(cred.user.uid).set({ name, email, phone, status: 'pending', createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    await _db.collection('requests').doc(cred.user.uid).set({ name, email, phone, status: 'pending', uid: cred.user.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    showScreen('pendingScreen');
  } catch(e) {
    let msg = 'Registration failed.';
    if (e.code === 'auth/email-already-in-use') msg = 'Email already registered.';
    showAuthMsg('registerMsg', msg, 'error');
  }
}

async function forgotPassword() {
  const email = document.getElementById('loginEmail')?.value.trim();
  if (!email) { showAuthMsg('loginMsg', 'Enter your email first.', 'error'); return; }
  try { await _auth.sendPasswordResetEmail(email); showAuthMsg('loginMsg', 'Reset email sent!', 'success'); }
  catch(e) { showAuthMsg('loginMsg', 'Error sending reset email.', 'error'); }
}

async function checkApproval() {
  if (!App.user) return;
  const doc = await _db.collection('users').doc(App.user.uid).get();
  if (doc.data()?.status === 'approved') initApp(App.user);
  else showToast('Still pending. Please wait for admin approval.');
}

function doLogout() {
  if (confirm('Logout?')) {
    App._unsubs.forEach(fn => fn()); App._unsubs = [];
    App.entries = []; App.user = null; App.dailyData = {};
    _auth.signOut(); showScreen('authScreen');
  }
}

function toggleUserMenu() { document.getElementById('userMenu')?.classList.toggle('show'); }
document.addEventListener('click', e => {
  const menu = document.getElementById('userMenu');
  if (menu?.classList.contains('show') && !e.target.closest('#userMenu') && !e.target.closest('#userAvatar')) menu.classList.remove('show');
});

// ══════════════════════════════════════════════════════════════
// MODULE: ui — DOM Rendering, Screen & Tab Management
// ══════════════════════════════════════════════════════════════

// Theme
function applyTheme(theme) {
  if (theme === 'dark') { document.body.classList.add('dark-mode'); const b = document.getElementById('themeBtn'); if (b) b.textContent = '☀️'; }
  else { document.body.classList.remove('dark-mode'); const b = document.getElementById('themeBtn'); if (b) b.textContent = '🌙'; }
}
async function toggleTheme() {
  const isDark = document.body.classList.toggle('dark-mode');
  document.getElementById('themeBtn').textContent = isDark ? '☀️' : '🌙';
  if (App.user) { try { await _db.collection('users').doc(App.user.uid).set({ theme: isDark ? 'dark' : 'light' }, { merge: true }); } catch(e) {} }
}

// Clock
function updateClock() {
  const now = new Date();
  const tEl = document.getElementById('clockTime'); if (tEl) tEl.textContent = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  const dEl = document.getElementById('clockDate'); if (dEl) dEl.textContent = now.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}
function syncInputTime() {
  const now = new Date();
  const d = document.getElementById('studyDate'); if (d) d.value = toLocalDate(now);
  const t = document.getElementById('studyTime'); if (t) t.value = p(now.getHours()) + ':' + p(now.getMinutes());
}

// Toast
function showToast(msg) {
  const ex = document.querySelector('.toast'); if (ex) ex.remove();
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 3400);
}

// Tab switching
function switchTab(name) {
  document.querySelectorAll('.page').forEach(pg => pg.classList.remove('active'));
  document.querySelectorAll('.nav-item, .sidebar-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + name)?.classList.add('active');
  document.getElementById('nav-' + name)?.classList.add('active');
  if (name === 'today')    renderToday();
  if (name === 'log')      renderLog();
  if (name === 'dash')     renderDashboard();
  if (name === 'tools')    initToolsTab();
  if (name === 'backup')   updateLastBackupInfo();
  if (name === 'calendar') renderCalendar();
}

function toggleSidebar() {
  const sb = document.querySelector('.sidebar');
  const btn = document.querySelector('.sidebar-toggle-btn');
  if (sb) {
    const isCollapsed = sb.classList.toggle('collapsed');
    if (btn) btn.textContent = isCollapsed ? '▶' : '◀';
  }
}

// ── Today Tab ─────────────────────────────────────────────────
function updateTodayBadge() {
  const items   = getTodayItems();
  const pending = items.filter(i => !i.done).length;
  const badge   = document.getElementById('todayCount');
  if (!badge) return;
  if (pending > 0)          { badge.textContent = pending; badge.style.display = 'inline-block'; badge.style.background = 'var(--teal)'; }
  else if (items.length > 0) { badge.textContent = '✓'; badge.style.display = 'inline-block'; badge.style.background = 'var(--green)'; }
  else                       { badge.style.display = 'none'; }
}

function renderToday() {
  const items = getTodayItems();
  const c     = document.getElementById('todayContent'); if (!c) return;
  const dl    = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  if (!items.length) { c.innerHTML = `<div class="empty-state"><span class="emoji">✅</span><p>Nothing to revise today.<br><span style="font-size:0.76rem;color:var(--text-dim)">${dl}</span></p></div>`; return; }
  const ts        = todayStr();
  const ratings   = (App.dailyData[ts] || {}).ratings || {};
  const doneCount = items.filter(i => i.done).length;
  const itemsHtml = items.map(item => {
    const rating = ratings[item.key];
    const rb = rating === 'easy' ? '<span style="background:#dcfce7;color:#16a34a;border-radius:5px;padding:1px 7px;font-size:0.55rem;font-weight:700;margin-left:4px;">Easy</span>' : rating === 'hard' ? '<span style="background:#fee2e2;color:#dc2626;border-radius:5px;padding:1px 7px;font-size:0.55rem;font-weight:700;margin-left:4px;">Hard</span>' : '';
    if (item.done) return `<div class="today-item done-item" id="ti-${item.key}" style="opacity:0.6;"><span class="today-badge">${item.label}</span><span class="today-topic" style="text-decoration:line-through;">${item.topic}</span>${rb}</div>`;
    return `<div class="today-item" id="ti-${item.key}"><span class="today-badge">${item.label}</span><span class="today-topic">${item.topic}</span><div style="display:flex;gap:4px;margin-left:auto;flex-shrink:0;"><button onclick="rateRevision('${item.key}','easy')" style="background:#dcfce7;border:none;border-radius:7px;padding:5px 8px;font-size:0.6rem;cursor:pointer;color:#16a34a;font-weight:700;">✅ Easy</button><button onclick="rateRevision('${item.key}','normal')" style="background:var(--surface2);border:1px solid var(--border);border-radius:7px;padding:5px 8px;font-size:0.6rem;cursor:pointer;color:var(--text-muted);font-weight:700;">✔ OK</button><button onclick="rateRevision('${item.key}','hard')" style="background:#fee2e2;border:none;border-radius:7px;padding:5px 8px;font-size:0.6rem;cursor:pointer;color:#dc2626;font-weight:700;">🔁 Hard</button></div></div>`;
  }).join('');
  c.innerHTML = `<div class="card card-green"><div class="card-header"><div class="live-dot"></div><h3>Revise Today</h3><span class="meta">${new Date().toLocaleDateString('en-IN',{day:'numeric',month:'short'})}</span></div><div style="padding:8px 16px 4px;font-size:0.56rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.1em;font-weight:600;">Rate each revision — Hard items repeat tomorrow automatically</div>${itemsHtml}<div class="done-summary"><span>✅ ${doneCount} / ${items.length} done</span>${doneCount > 0 ? '<button class="reset-btn" onclick="resetDone()">Reset</button>' : ''}</div></div>`;
}

async function toggleDone(key) {
  if (!App.user) return;
  const ts    = todayStr();
  const daily = App.dailyData[ts] || { done: {}, ratings: {} };
  const was   = !!(daily.done || {})[key];
  App.dailyData[ts] = daily;
  if (was) delete App.dailyData[ts].done[key]; else App.dailyData[ts].done[key] = true;
  renderToday(); updateTodayBadge();
  try { await dbToggleDone(App.user.uid, ts, key, was); } catch(e) { console.error(e); }
}

async function rateRevision(key, rating) {
  if (!App.user) return;
  const ts = todayStr();
  App.dailyData[ts] = App.dailyData[ts] || { done: {}, ratings: {} };
  App.dailyData[ts].done[key] = true;
  App.dailyData[ts].ratings[key] = rating;
  renderToday(); updateTodayBadge();
  try { await dbRateRevision(App.user.uid, ts, key, rating); } catch(e) { console.error(e); }
  const msgs = { easy: '✅ Easy! Great work!', normal: '✔ Marked done!', hard: '🔁 Repeat scheduled for tomorrow!' };
  showToast(msgs[rating] || 'Done!');
}

async function resetDone() {
  if (!App.user) return;
  const ts = todayStr();
  App.dailyData[ts] = { done: {}, ratings: {} };
  renderToday(); updateTodayBadge();
  try { await _db.collection('users').doc(App.user.uid).collection('daily').doc(ts).set({ done: {}, ratings: {} }); } catch(e) {}
  showToast('Checkboxes reset!');
}

// Bulk notify
window.bulkNotifyToday = async function() {
  const items = getTodayItems();
  if (!items.length) return showToast('Nothing scheduled for today!');
  if (!window.Notification) return showToast('Notifications not supported.');
  if (Notification.permission !== 'granted') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return showToast('Notification permission denied.');
  }
  items.forEach((item, idx) => setTimeout(() => { try { new Notification(`Revise: ${item.topic}`, { body: `Due: ${item.label}`, icon: '/icon-192.png', tag: 'study-rem' }); } catch(e) {} }, idx * 150));
  showToast(`🔔 ${items.length} reminders sent!`);
};

// ── Add Entry ─────────────────────────────────────────────────
async function addEntry() {
  const topic   = document.getElementById('topicInput')?.value.trim();
  const dateStr = document.getElementById('studyDate')?.value;
  const timeStr = document.getElementById('studyTime')?.value;
  if (!topic) { showToast('Please enter a topic!'); return; }
  const revisions = calcDates(dateStr, timeStr);
  App.pendingEntry = { id: Date.now(), topic, dateStr, timeStr, revisions: revisions.map(r => ({ ...r, datetime: r.datetime.toISOString() })) };
  showResult(App.pendingEntry, revisions);
  const topicInput = document.getElementById('topicInput'); if (topicInput) topicInput.value = '';
  showToast('Preview ready! Tap the green button to save.');
  setTimeout(() => document.getElementById('resultCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
}

window.savePendingEntry = async function() {
  if (!App.pendingEntry || !App.user) return;
  const btn = document.getElementById('addToCalIcsBtn');
  try {
    if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }
    await dbSaveEntry(App.user.uid, App.pendingEntry);
    if (btn) { btn.innerHTML = '✅<div><span style="display:block;font-weight:700;">Saved to Tracker!</span><span style="font-size:0.64rem;">Firestore sync complete</span></div>'; btn.style.background = 'linear-gradient(135deg,#059669,#10b981)'; }
    showToast('Saved! Your revision schedule is live.');
    App.pendingEntry = null;
  } catch(e) { showToast('Error: ' + e.message); if (btn) { btn.disabled = false; btn.textContent = 'Save to Study Tracker'; } }
};

function showResult(entry, revisions) {
  const rc = document.getElementById('resultCard'); if (rc) rc.style.display = 'block';
  const rt = document.getElementById('resultTopic'); if (rt) rt.textContent = entry.topic;
  const il = document.getElementById('intervalsList'); if (!il) return;
  il.innerHTML = revisions.map((r, i) => {
    const dl = r.datetime.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const tl = r.datetime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    return `<div class="iv-row" id="ivrow-${i}"><span class="iv-tag ${r.type}">${r.label}</span><div class="iv-info"><div class="iv-date">${dl}</div><div class="iv-time">${tl}</div></div></div>`;
  }).join('');
}

function cancelProgress() { document.getElementById('progressOverlay')?.classList.remove('show'); }

// ── Log Tab ───────────────────────────────────────────────────
function renderLog() {
  const total    = App.entries.length;
  const totalRev = App.entries.reduce((a, e) => a + e.revisions.length, 0);
  const todayN   = getTodayItems().length;
  const sr = document.getElementById('statsRow');
  if (sr) sr.innerHTML = `<div class="stat-box"><div class="stat-num">${total}</div><div class="stat-lbl">Topics</div></div><div class="stat-box"><div class="stat-num">${totalRev}</div><div class="stat-lbl">Revisions</div></div><div class="stat-box"><div class="stat-num">${todayN}</div><div class="stat-lbl">Due Today</div></div>`;
  renderPerformanceScore();
  const c = document.getElementById('logContainer'); if (!c) return;
  if (!App.entries.length) { c.innerHTML = '<div class="empty-state"><span class="emoji">📖</span><p>No entries yet. Add your first topic above!</p></div>'; return; }
  const filtered = App.searchQuery ? App.entries.filter(e => e.topic.toLowerCase().includes(App.searchQuery)) : App.entries;
  if (!filtered.length) { c.innerHTML = `<div class="empty-state"><span class="emoji">🔍</span><p>No topics found for "${App.searchQuery}"</p></div>`; return; }
  c.innerHTML = filtered.map(entry => {
    const [y, m, d] = entry.dateStr.split('-').map(Number);
    const dl = new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    const topic = App.searchQuery ? entry.topic.replace(new RegExp('('+App.searchQuery+')', 'gi'), '<mark style="background:#fef9c3;border-radius:3px;padding:0 2px;">$1</mark>') : entry.topic;
    return `<div class="log-item"><div class="log-left"><div class="log-topic">${topic}</div><div class="log-meta">${dl} · ${entry.timeStr} · 7 revisions</div></div><div class="log-actions"><button class="btn-sm" onclick="reOpen('${entry.id}')">View</button><button class="btn-sm del" onclick="deleteEntry('${entry.id}')">✕</button></div></div>`;
  }).join('');
}

function reOpen(id) {
  const entry = App.entries.find(e => String(e.id) === String(id)); if (!entry) return;
  const revisions = entry.revisions.map(r => ({ ...r, datetime: new Date(r.datetime) }));
  switchTab('add');
  setTimeout(() => { showResult(entry, revisions); document.getElementById('resultCard')?.scrollIntoView({ behavior: 'smooth' }); }, 200);
}

async function deleteEntry(id) {
  if (!confirm('Remove this entry?') || !App.user) return;
  try { await dbDeleteEntry(App.user.uid, id); showToast('Entry removed'); }
  catch(e) { showToast('Error removing entry.'); }
}

function filterLog() {
  App.searchQuery = document.getElementById('searchInput')?.value.toLowerCase().trim() || '';
  const cb = document.getElementById('searchClear'); if (cb) cb.style.display = App.searchQuery ? 'block' : 'none';
  renderLog();
}

function clearSearch() {
  const si = document.getElementById('searchInput'); if (si) si.value = '';
  App.searchQuery = '';
  const cb = document.getElementById('searchClear'); if (cb) cb.style.display = 'none';
  renderLog();
}

// ── Dashboard Tab ─────────────────────────────────────────────
function renderCountdown() {
  const today_ = new Date(); today_.setHours(0, 0, 0, 0);
  function setBox(daysEl, dateEl, dateStr) {
    if (!daysEl) return;
    if (!dateStr) { daysEl.textContent = '--'; if (dateEl) dateEl.textContent = 'Tap Set Dates'; daysEl.className = 'exam-days ok'; return; }
    const exam = new Date(dateStr); exam.setHours(0, 0, 0, 0);
    const diff = Math.ceil((exam - today_) / (1000 * 60 * 60 * 24));
    daysEl.textContent = diff > 0 ? diff : 'Done!';
    if (dateEl) dateEl.textContent = exam.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    daysEl.className = 'exam-days ' + (diff <= 30 ? 'urgent' : diff <= 60 ? 'soon' : 'ok');
  }
  setBox(document.getElementById('mainDays'), document.getElementById('mainDateDisp'), App.examDates.mains);
  setBox(document.getElementById('advDays'),  document.getElementById('advDateDisp'),  App.examDates.adv);
}

function openExamModal() {
  if (App.examDates.mains) { const el = document.getElementById('mainDate'); if (el) el.value = App.examDates.mains; }
  if (App.examDates.adv)   { const el = document.getElementById('advDate');  if (el) el.value = App.examDates.adv;  }
  document.getElementById('examModal')?.classList.add('show');
}
function closeExamModal() { document.getElementById('examModal')?.classList.remove('show'); }
async function saveExamDates() {
  const mains = document.getElementById('mainDate')?.value;
  const adv   = document.getElementById('advDate')?.value;
  App.examDates = { mains, adv };
  try { await dbSaveSettings(App.user.uid, 'examdates', { mains, adv }); } catch(e) {}
  closeExamModal(); renderCountdown(); showToast('Exam dates saved!');
}

function renderSubjects() {
  const subjects = { Physics: { icon: '⚡', topics: 0 }, Chemistry: { icon: '🧪', topics: 0 }, Maths: { icon: '📐', topics: 0 } };
  const total = App.entries.length || 1;
  App.entries.forEach(e => subjects[classifySubject(e.topic)].topics++);
  const sr = document.getElementById('subjRow'); if (!sr) return;
  sr.innerHTML = ['Physics', 'Chemistry', 'Maths'].map(name => {
    const s = subjects[name]; const pct = Math.round(s.topics / total * 100);
    const cls = name === 'Physics' ? 'subj-phy' : name === 'Chemistry' ? 'subj-chem' : 'subj-math';
    return `<div class="subj-card ${cls}"><div class="s-icon">${s.icon}</div><div class="s-name">${name}</div><div class="s-num">${s.topics}</div><div class="s-lbl">topics</div><div class="s-bar-wrap"><div class="s-bar" style="width:${pct}%"></div></div></div>`;
  }).join('');
}

function renderStreak() {
  const { current, longest, total } = calcStreak();
  const sr = document.getElementById('streakRow'); if (!sr) return;
  sr.innerHTML = `<div class="streak-box"><div class="streak-icon">🔥</div><div class="streak-num">${current}</div><div class="streak-lbl">Current Streak</div></div><div class="streak-box"><div class="streak-icon">🏆</div><div class="streak-num">${longest}</div><div class="streak-lbl">Best Streak</div></div><div class="streak-box"><div class="streak-icon">📅</div><div class="streak-num">${total}</div><div class="streak-lbl">Days Studied</div></div>`;
}

function renderHeatmap() {
  const studyCount = {};
  App.entries.forEach(e => { studyCount[e.dateStr] = (studyCount[e.dateStr] || 0) + 1; });
  const grid  = document.getElementById('heatmapGrid'); if (!grid) return;
  const today_ = new Date(); today_.setHours(0, 0, 0, 0);
  const weeks = 26, start = new Date(today_);
  start.setDate(start.getDate() - weeks * 7 + 1);
  const dow = start.getDay(); start.setDate(start.getDate() - (dow === 0 ? 6 : dow - 1));
  let html = '', currentMonth = -1;
  for (let w = 0; w < weeks + 1; w++) {
    let wh = '', ml = '';
    for (let d2 = 0; d2 < 7; d2++) {
      const cur = new Date(start); cur.setDate(start.getDate() + w * 7 + d2);
      if (cur > today_) { wh += '<div class="hday" style="background:transparent"></div>'; continue; }
      if (cur.getMonth() !== currentMonth) { currentMonth = cur.getMonth(); ml = cur.toLocaleDateString('en-IN', { month: 'short' }); }
      const ds = toLocalDate(cur); const cnt = studyCount[ds] || 0;
      wh += `<div class="hday hday-${cnt === 0 ? 0 : cnt === 1 ? 1 : cnt <= 2 ? 2 : cnt <= 4 ? 3 : 4}"></div>`;
    }
    html += `<div class="heatmap-month"><div class="heatmap-month-label">${ml || ''}</div><div class="heatmap-week">${wh}</div></div>`;
  }
  grid.innerHTML = html;
  const sub = document.getElementById('heatmapSub'); if (sub) sub.textContent = `${Object.keys(studyCount).length} days studied · ${App.entries.length} topics logged`;
}

function renderPerformanceScore() {
  const pc = document.getElementById('perfCard');
  if (!App.entries.length) { if (pc) pc.style.display = 'none'; return; }
  if (pc) pc.style.display = 'block';
  const { score, done, pending, label } = calcPerformanceScore();
  const { current } = calcStreak();
  const ps = document.getElementById('perfScore'); if (ps) ps.innerHTML = score + '<span>%</span>';
  const pb = document.getElementById('perfBar'); if (pb) pb.style.width = score + '%';
  const pl = document.getElementById('perfLabel'); if (pl) pl.textContent = label;
  const pd = document.getElementById('perfDone'); if (pd) pd.textContent = done;
  const pp = document.getElementById('perfPending'); if (pp) pp.textContent = pending;
  const pst = document.getElementById('perfStreak'); if (pst) pst.textContent = current;
}

function renderDashboard() { renderCountdown(); renderSubjects(); renderStreak(); renderHeatmap(); renderPerformanceScore(); updTgt(); }

// ── Push Notifications ────────────────────────────────────────
async function toggleNotifications() {
  if (!('Notification' in window)) { showToast('Notifications not supported.'); return; }
  if (Notification.permission === 'denied') { showToast('Blocked. Enable in browser settings.'); updateNotifUI(); return; }
  if (Notification.permission === 'granted') { showToast('Notifications already ON ✅'); return; }
  const result = await Notification.requestPermission();
  updateNotifUI();
  if (result === 'granted') {
    showToast('Notifications enabled! You will get revision reminders.');
    if ('serviceWorker' in navigator && 'PushManager' in window && App.user) {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_KEY });
        await _db.collection('users').doc(App.user.uid).set({ pushSubscription: JSON.parse(JSON.stringify(sub)) }, { merge: true });
      } catch(e) { console.error('Push sub error:', e); }
    }
    setTimeout(() => { try { new Notification('Study Tracker', { body: 'Notifications are working! ✅', icon: '/icon-192.png' }); } catch(e) {} }, 1000);
  } else {
    showToast('Notification permission denied.');
  }
}

function updateNotifUI() {
  const perm   = Notification?.permission || 'default';
  const toggle = document.getElementById('notifToggle');
  const status = document.getElementById('notifStatus');
  const sub    = document.getElementById('notifSubText');
  if (toggle) toggle.checked = perm === 'granted';
  if (status) { status.className = 'nb-status ' + (perm === 'granted' ? 'on' : 'off'); status.textContent = perm === 'granted' ? 'ON' : perm === 'denied' ? 'BLOCKED' : 'OFF'; }
  if (sub)    sub.textContent = perm === 'granted' ? 'Reminders enabled for today\'s revisions' : perm === 'denied' ? 'Enable in browser settings >' : 'Tap to enable push notifications';
}

// ── Backup ────────────────────────────────────────────────────
document.getElementById('backupNowBtn')?.addEventListener('click', () => { exportData(); document.getElementById('backupBanner')?.classList.remove('show'); });
document.getElementById('backupDismiss')?.addEventListener('click', () => { document.getElementById('backupBanner')?.classList.remove('show'); });

function exportData() {
  if (!App.entries.length) { showToast('No data to export!'); return; }
  const backup = { version: '4.0', exportDate: new Date().toISOString(), appName: 'Study Tracker', user: App.user?.email, totalEntries: App.entries.length, entries: App.entries };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `studytracker-backup-${new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'2-digit',year:'numeric'}).replace(/\//g,'-')}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  updateLastBackupInfo(); showToast(`Backup saved! ${App.entries.length} entries exported.`);
}

document.getElementById('importFileInput')?.addEventListener('change', function(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async function(ev) {
    try {
      const backup = JSON.parse(ev.target.result);
      if (!backup.entries || !Array.isArray(backup.entries)) { showToast('Invalid backup file!'); return; }
      if (!confirm(`Import ${backup.entries.length} entries?`)) return;
      for (const entry of backup.entries) await dbSaveEntry(App.user.uid, entry);
      showToast(`Imported ${backup.entries.length} entries!`); switchTab('log');
    } catch(err) { showToast('Could not read file.'); }
  };
  reader.readAsText(file); this.value = '';
});

function updateLastBackupInfo() {
  const el = document.getElementById('lastBackupInfo');
  if (el) el.textContent = `${App.entries.length} entries synced to Firestore`;
}

// ── PDF Report ────────────────────────────────────────────────
function downloadPDFReport() {
  if (!App.entries.length) { showToast('No data yet!'); return; }
  const { score, done, pending } = calcPerformanceScore();
  const { current, longest, total } = calcStreak();
  const userName = App.user?.displayName || App.user?.email || 'Student';
  const dateStr  = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Study Tracker Report</title><style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;background:#f8f9fc;color:#0f172a;padding:30px;}.header{background:linear-gradient(135deg,#0284c7,#0ea5e9);border-radius:16px;padding:28px;color:#fff;margin-bottom:24px;text-align:center;}.score-card{background:linear-gradient(135deg,#4f46e5,#6366f1);border-radius:12px;padding:20px;margin-bottom:24px;color:#fff;}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px;}.card{background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 6px rgba(0,0,0,0.08);}.big-num{font-size:2.5rem;font-weight:800;color:#0ea5e9;}.label{font-size:0.7rem;color:#475569;margin-top:4px;}@media print{button{display:none!important;}}</style></head><body><div class="header"><h1>📚 Study Tracker</h1><p>Progress Report — ${userName}</p><div style="font-size:0.75rem;opacity:0.7;">${dateStr}</div></div><div class="score-card"><h3 style="font-size:0.65rem;opacity:0.8;text-transform:uppercase;margin-bottom:8px;">Overall Performance</h3><div style="font-size:3rem;font-weight:800;">${score}<span style="font-size:1.5rem;opacity:0.8">%</span></div><div style="font-size:0.8rem;margin-top:4px;">${score>=90?'🔥 Excellent!':score>=70?'✅ Good progress!':score>=50?'📈 Getting there!':'💪 Keep pushing!'}</div></div><div class="grid"><div class="card"><div class="big-num">${App.entries.length}</div><div class="label">Topics Logged</div></div><div class="card"><div class="big-num">${done}</div><div class="label">Revised</div></div><div class="card"><div class="big-num">${current}</div><div class="label">Day Streak</div></div><div class="card"><div class="big-num">${total}</div><div class="label">Days Studied</div></div></div><div style="text-align:center;margin-top:20px;"><button onclick="window.print()" style="background:linear-gradient(135deg,#0284c7,#0ea5e9);color:#fff;border:none;border-radius:10px;padding:14px 32px;font-weight:700;cursor:pointer;">🖨️ Save as PDF</button></div></body></html>`);
  win.document.close();
  showToast('📄 Report opened!');
}

// ══════════════════════════════════════════════════════════════
// TOOLS TAB — Time Tracker, Mistakes, Mocks, Pomodoro, Formulas
// ══════════════════════════════════════════════════════════════
let _st = 6;

// Study target modal (dynamically created)
(function() {
  const m = document.createElement('div');
  m.id = '_tm';
  m.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:6001;align-items:center;justify-content:center;padding:20px;';
  m.innerHTML = '<div style="background:var(--surface);border-radius:20px;padding:24px;width:100%;max-width:320px;box-shadow:0 20px 60px rgba(0,0,0,0.2);"><div style="font-family:Poppins,sans-serif;font-size:1rem;font-weight:700;margin-bottom:12px;">Set Daily Study Target</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px;" id="_to">' + [4,5,6,7,8,10].map(h => `<div onclick="pickTgt(${h})" data-h="${h}" style="background:#f1f5f9;border:1.5px solid #cbd5e1;border-radius:10px;padding:10px 4px;text-align:center;cursor:pointer;"><div style="font-family:Poppins,sans-serif;font-size:1.3rem;font-weight:700;color:#d97706;">${h}</div><div style="font-size:0.55rem;color:#94a3b8;">hours</div></div>`).join('') + '</div><div style="display:flex;gap:10px;"><button onclick="closeTgtModal()" style="flex:1;background:#f1f5f9;border:1px solid #cbd5e1;color:#475569;border-radius:10px;padding:12px;cursor:pointer;">Cancel</button><button onclick="saveTgt()" style="flex:2;background:linear-gradient(135deg,#d97706,#f59e0b);color:#fff;border:none;border-radius:10px;padding:12px;font-family:Poppins,sans-serif;font-size:0.82rem;font-weight:700;cursor:pointer;">Save</button></div></div>';
  document.body.appendChild(m);
})();

function openTgtModal() {
  _st = App.studyTarget;
  document.querySelectorAll('#_to [data-h]').forEach(e => {
    const h = parseFloat(e.getAttribute('data-h'));
    e.style.background = h === _st ? '#fef3c7' : '#f1f5f9';
    e.style.border = h === _st ? '1.5px solid #d97706' : '1.5px solid #cbd5e1';
  });
  document.getElementById('_tm').style.display = 'flex';
}
function closeTgtModal() { document.getElementById('_tm').style.display = 'none'; }
function pickTgt(h) {
  _st = h;
  document.querySelectorAll('#_to [data-h]').forEach(e => {
    const dh = parseFloat(e.getAttribute('data-h'));
    e.style.background = dh === h ? '#fef3c7' : '#f1f5f9';
    e.style.border = dh === h ? '1.5px solid #d97706' : '1.5px solid #cbd5e1';
  });
}
async function saveTgt() {
  App.studyTarget = _st;
  if (App.user) { try { await dbSaveSettings(App.user.uid, 'studytarget', { hours: _st }); } catch(e) {} }
  closeTgtModal(); updTgt(); showToast('Target: ' + _st + ' hrs/day');
}

async function logTgt(subj, hrs) {
  if (!App.user) return;
  const ts = todayStr();
  App.studyTime[ts] = App.studyTime[ts] || {};
  App.studyTime[ts][subj] = (App.studyTime[ts][subj] || 0) + hrs;
  updTgt();
  try { await dbLogStudyTime(App.user.uid, ts, subj, hrs); } catch(e) {}
  showToast('+' + (hrs >= 1 ? hrs + 'hr' : (hrs * 60) + 'min') + ' ' + subj);
}

function updTgt() {
  const tg = App.studyTarget, ts = todayStr();
  const d = App.studyTime[ts] || {};
  const c = Object.values(d).reduce((a, b) => a + b, 0);
  const pct = Math.min((c / tg) * 100, 100);
  const ce = document.getElementById('tgtCur'); if (!ce) return;
  ce.textContent = c.toFixed(1);
  const tgEl = document.getElementById('tgtGoal'); if (tgEl) tgEl.textContent = tg;
  const bar = document.getElementById('tgtBar'), msg = document.getElementById('tgtMsg');
  if (bar) bar.style.width = pct + '%';
  if (c >= tg) {
    if (bar) bar.style.background = 'linear-gradient(90deg,#16a34a,#22c55e)';
    if (msg) { msg.textContent = 'Target complete!'; msg.style.color = '#16a34a'; }
  } else {
    if (bar) bar.style.background = 'linear-gradient(90deg,#d97706,#f59e0b)';
    if (msg) { msg.textContent = (tg - c).toFixed(1) + ' hours remaining'; msg.style.color = 'var(--text-dim)'; }
  }
}

// Time tracker
function getTodayTimeData() { return App.studyTime[todayStr()] || {}; }

function addTime(subj, hrs) { logTgt(subj, hrs); renderTimeTracker(); renderGoalStreak(); }

async function resetTodayTime() {
  if (!confirm("Reset today's time log?")) return;
  const ts = todayStr();
  App.studyTime[ts] = {};
  renderTimeTracker(); renderGoalStreak();
  try { await _db.collection('users').doc(App.user.uid).collection('studytime').doc(ts).delete(); } catch(e) {}
}

function renderTimeTracker() {
  const d = getTodayTimeData();
  const tp = document.getElementById('tt-phy'), tc = document.getElementById('tt-chem'), tm = document.getElementById('tt-math');
  if (tp) tp.textContent = (d['Physics'] || 0).toFixed(1) + 'h';
  if (tc) tc.textContent = (d['Chemistry'] || 0).toFixed(1) + 'h';
  if (tm) tm.textContent = (d['Maths'] || 0).toFixed(1) + 'h';
  renderWeekChart();
}

function renderWeekChart() {
  const canvas = document.getElementById('timeChart'); if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d2 = new Date(); d2.setDate(d2.getDate() - i);
    const key = toLocalDate(d2); const data = App.studyTime[key] || {};
    days.push({ label: d2.toLocaleDateString('en-IN', { weekday: 'short' }), phy: data['Physics'] || 0, chem: data['Chemistry'] || 0, math: data['Maths'] || 0, total: (data['Physics'] || 0) + (data['Chemistry'] || 0) + (data['Maths'] || 0) });
  }
  canvas.width = (canvas.offsetWidth || 300) * (window.devicePixelRatio || 1);
  canvas.height = 80 * (window.devicePixelRatio || 1);
  ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
  const W = canvas.offsetWidth || 300, H = 80;
  ctx.clearRect(0, 0, W, H);
  const maxH = Math.max(...days.map(d => d.total), 1);
  const barW = (W - 40) / 7 * 0.5, gap = (W - 40) / 7;
  days.forEach((d, i) => {
    const x = 20 + i * gap, y = H - 14;
    const bH = (d.phy / maxH) * (H - 20), bH2 = (d.chem / maxH) * (H - 20), bH3 = (d.math / maxH) * (H - 20);
    ctx.fillStyle = '#3d9bef'; ctx.fillRect(x - barW / 2, y - bH, barW, bH);
    ctx.fillStyle = '#22c55e'; ctx.fillRect(x - barW / 2, y - bH - bH2, barW, bH2);
    ctx.fillStyle = '#f59e0b'; ctx.fillRect(x - barW / 2, y - bH - bH2 - bH3, barW, bH3);
    ctx.fillStyle = '#94a3b8'; ctx.font = '9px Inter,sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(d.label, x, H - 2);
  });
}

// Mistakes
let _mFilter = 'all';
function openMistakeForm() { document.getElementById('mistakeModal')?.classList.add('show'); }
function closeMistakeForm() { document.getElementById('mistakeModal')?.classList.remove('show'); }
async function saveMistake() {
  const subj = document.getElementById('mSubject')?.value, type = document.getElementById('mType')?.value;
  const topic = document.getElementById('mTopic')?.value.trim(), q = document.getElementById('mQuestion')?.value.trim(), note = document.getElementById('mNote')?.value.trim();
  if (!topic) { showToast('Enter a topic!'); return; }
  App.mistakes.unshift({ id: Date.now(), subj, type, topic, q, note, date: todayStr() });
  closeMistakeForm();
  ['mTopic', 'mQuestion', 'mNote'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  renderMistakes(); showToast('Mistake logged!');
  try { await dbSaveData(App.user.uid, 'mistakes', App.mistakes); } catch(e) {}
}
function filterMistakes(f) {
  _mFilter = f;
  ['all', 'Physics', 'Chemistry', 'Maths'].forEach(s => {
    const id = 'mf-' + (s === 'all' ? 'all' : s === 'Physics' ? 'phy' : s === 'Chemistry' ? 'chem' : 'math');
    const el = document.getElementById(id); if (!el) return;
    el.style.background = s === f ? 'var(--teal)' : 'var(--surface2)';
    el.style.color = s === f ? '#fff' : 'var(--text-muted)';
    el.style.border = s === f ? 'none' : '1px solid var(--border)';
  });
  renderMistakes();
}
async function deleteMistake(id) {
  App.mistakes = App.mistakes.filter(m => m.id !== id); renderMistakes();
  try { await dbSaveData(App.user.uid, 'mistakes', App.mistakes); } catch(e) {}
}
function renderMistakes() {
  const list = document.getElementById('mistakeList'); if (!list) return;
  const filtered = _mFilter === 'all' ? App.mistakes : App.mistakes.filter(m => m.subj === _mFilter);
  if (!filtered.length) { list.innerHTML = '<div class="empty-state"><span class="emoji">📕</span><p>No mistakes logged yet.</p></div>'; return; }
  const colors = { Physics: '#3d9bef', Chemistry: '#22c55e', Maths: '#f59e0b' };
  list.innerHTML = filtered.map(m => `<div class="mistake-item"><div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;"><span style="background:${colors[m.subj]}22;color:${colors[m.subj]};border:1px solid ${colors[m.subj]}44;border-radius:5px;padding:1px 7px;font-size:0.55rem;font-weight:700;">${m.subj}</span><span style="background:#fee2e2;color:#dc2626;border-radius:5px;padding:1px 7px;font-size:0.55rem;font-weight:700;">${m.type}</span><span style="margin-left:auto;font-size:0.55rem;color:var(--text-dim);">${m.date}</span><button onclick="deleteMistake(${m.id})" style="background:none;border:none;font-size:0.75rem;cursor:pointer;color:var(--text-dim);">✕</button></div><div class="mistake-topic">${m.topic}${m.q ? ': ' + m.q : ''}</div>${m.note ? `<div class="mistake-reason">💡 ${m.note}</div>` : ''}</div>`).join('');
}

// Mocks
function openMockForm() { document.getElementById('mockModal')?.classList.add('show'); }
function closeMockForm() { document.getElementById('mockModal')?.classList.remove('show'); }
async function saveMock() {
  const name = document.getElementById('mockName')?.value.trim() || 'Mock Test';
  const total = parseFloat(document.getElementById('mockTotal')?.value) || 0;
  const max   = parseFloat(document.getElementById('mockMax')?.value) || 300;
  const phy   = parseFloat(document.getElementById('mockPhy')?.value) || 0;
  const chem  = parseFloat(document.getElementById('mockChem')?.value) || 0;
  const math  = parseFloat(document.getElementById('mockMath')?.value) || 0;
  const note  = document.getElementById('mockNote')?.value.trim();
  App.mocks.push({ id: Date.now(), name, total, max, phy, chem, math, note, date: todayStr() });
  closeMockForm();
  ['mockName','mockTotal','mockPhy','mockChem','mockMath','mockNote'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const mm = document.getElementById('mockMax'); if (mm) mm.value = '300';
  renderMocks(); showToast('Mock test saved!');
  try { await dbSaveData(App.user.uid, 'mocks', App.mocks); } catch(e) {}
}
async function deleteMock(id) {
  App.mocks = App.mocks.filter(m => m.id !== id); renderMocks();
  try { await dbSaveData(App.user.uid, 'mocks', App.mocks); } catch(e) {}
}
function renderMocks() {
  const list = document.getElementById('mockList'); if (!list) return;
  if (!App.mocks.length) { list.innerHTML = '<div class="empty-state"><span class="emoji">📝</span><p>No mock tests logged yet.</p></div>'; renderMockChart(); return; }
  list.innerHTML = App.mocks.slice().reverse().map(m => {
    const pct = Math.round(m.total / m.max * 100), col = pct >= 70 ? '#22c55e' : pct >= 50 ? '#f59e0b' : '#dc2626';
    return `<div class="mock-item"><div class="mock-score" style="color:${col}">${m.total}<span style="font-size:0.55rem;color:var(--text-dim);">/${m.max}</span></div><div class="mock-detail"><div style="font-size:0.78rem;font-weight:600;color:var(--text);">${m.name}</div><div>⚡${m.phy} 🧪${m.chem} 📐${m.math} · ${m.date}</div>${m.note ? `<div style="color:var(--text-dim);font-size:0.62rem;">${m.note}</div>` : ''}</div><span class="mock-badge" style="background:${col}22;color:${col};border:1px solid ${col}44;">${pct}%</span><button onclick="deleteMock(${m.id})" style="background:none;border:none;font-size:0.75rem;cursor:pointer;color:var(--text-dim);">✕</button></div>`;
  }).join('');
  renderMockChart();
}
function renderMockChart() {
  const el = document.getElementById('mockScoreChart'); if (!el) return;
  if (App.mocks.length < 2) { el.innerHTML = ''; return; }
  const last8 = App.mocks.slice(-8), barH = 50;
  el.innerHTML = '<div style="display:flex;gap:4px;align-items:flex-end;padding:4px 0;">' + last8.map(m => {
    const h = Math.round((m.total / m.max) * barH), pct = Math.round(m.total / m.max * 100), col = pct >= 70 ? '#22c55e' : pct >= 50 ? '#f59e0b' : '#dc2626';
    return `<div style="display:flex;flex-direction:column;align-items:center;flex:1;gap:3px;"><div style="font-size:0.6rem;font-weight:700;color:${col}">${pct}%</div><div style="width:100%;height:${barH}px;display:flex;align-items:flex-end;justify-content:center;"><div style="width:70%;background:${col};border-radius:4px 4px 0 0;height:${Math.max(h, 2)}px;"></div></div><div style="font-size:0.48rem;color:var(--text-dim);">${m.name.length > 8 ? m.name.slice(0, 8) + '…' : m.name}</div></div>`;
  }).join('') + '</div>';
}

// Goal Streak
function renderGoalStreak() {
  const tg = App.studyTarget;
  const goalEl = document.getElementById('goalTarget'); if (goalEl) goalEl.textContent = tg + 'h';
  let cur = 0, best = 0;
  for (let i = 0; i < 60; i++) {
    const d2 = new Date(); d2.setDate(d2.getDate() - i);
    const data = App.studyTime[toLocalDate(d2)] || {};
    const total_ = Object.values(data).reduce((a, b) => a + b, 0);
    if (total_ >= tg) { cur++; if (cur > best) best = cur; } else if (i > 0) break;
    if (i === 0 && total_ < tg) cur = 0;
  }
  const gs = document.getElementById('goalStreak'); if (gs) gs.textContent = cur;
  const gb = document.getElementById('goalBest'); if (gb) gb.textContent = best;
  const gm = document.getElementById('goalMsg');
  if (gm) {
    const todayH = Object.values(App.studyTime[todayStr()] || {}).reduce((a, b) => a + b, 0);
    gm.innerHTML = todayH >= tg ? '✅ Goal reached today! Streak active 🔥' : '📖 Study ' + (tg - todayH).toFixed(1) + 'h more to keep your streak!';
  }
}

// Pomodoro
let _pomoTimer = null, _pomoLeft = 25 * 60, _pomoTotal = 25 * 60, _pomoRunning = false, _pomoSessions = 0;
function setPomoMode(mins, label) {
  resetPomo(); _pomoTotal = _pomoLeft = mins * 60;
  const lbl = document.getElementById('pomoLabel'); if (lbl) lbl.textContent = label;
  ['pomo-25', 'pomo-50', 'pomo-5'].forEach(id => { const el = document.getElementById(id); if (el) { el.style.background = 'var(--surface2)'; el.style.color = 'var(--text-muted)'; el.style.border = '1px solid var(--border)'; } });
  const active = document.getElementById(mins === 25 ? 'pomo-25' : mins === 50 ? 'pomo-50' : 'pomo-5');
  if (active) { active.style.background = 'var(--teal)'; active.style.color = '#fff'; active.style.border = 'none'; }
  updatePomoDisplay();
}
function updatePomoDisplay() {
  const m = Math.floor(_pomoLeft / 60), s = _pomoLeft % 60;
  const te = document.getElementById('pomoTime'); if (te) te.textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  const circ = document.getElementById('pomoCircle'); if (circ) circ.style.strokeDashoffset = 377 * (1 - _pomoLeft / _pomoTotal);
}
function startPomo() {
  if (_pomoRunning) { clearInterval(_pomoTimer); _pomoRunning = false; document.getElementById('pomoStartBtn').textContent = '▶ Start'; return; }
  _pomoRunning = true; document.getElementById('pomoStartBtn').textContent = '⏸ Pause';
  _pomoTimer = setInterval(() => {
    if (_pomoLeft <= 0) {
      clearInterval(_pomoTimer); _pomoRunning = false; document.getElementById('pomoStartBtn').textContent = '▶ Start';
      _pomoSessions++; const se = document.getElementById('pomoSessions'); if (se) se.textContent = _pomoSessions + ' sessions today';
      const subj = document.getElementById('pomoSubject')?.value, mins = _pomoTotal / 60;
      if (mins > 4) addTime(subj, mins / 60);
      showToast('🍅 Session complete! +' + Math.round(mins) + 'min logged'); return;
    }
    _pomoLeft--; updatePomoDisplay();
  }, 1000);
}
function resetPomo() { clearInterval(_pomoTimer); _pomoRunning = false; _pomoLeft = _pomoTotal; const b = document.getElementById('pomoStartBtn'); if (b) b.textContent = '▶ Start'; updatePomoDisplay(); }

// Question Tracker
const _qData = {};
function getQData() { return _qData[todayStr()] || {}; }
function addQ(subj, n) {
  const ts = todayStr(); _qData[ts] = _qData[ts] || {}; _qData[ts][subj] = (_qData[ts][subj] || 0) + n;
  renderQ(); showToast('+' + n + ' ' + subj + ' questions');
}
function renderQ() {
  const d = getQData();
  const ep = document.getElementById('qa-phy'), ec = document.getElementById('qa-chem'), em = document.getElementById('qa-math'), et = document.getElementById('qa-total');
  if (ep) ep.textContent = d['Physics'] || 0; if (ec) ec.textContent = d['Chemistry'] || 0;
  if (em) em.textContent = d['Maths'] || 0; if (et) et.textContent = (d['Physics'] || 0) + (d['Chemistry'] || 0) + (d['Maths'] || 0);
}

// Formulas
const FORMULAS = {
  Physics: [
    { section: 'Kinematics', items: [{name:'Displacement',eq:'s = ut + ½at²',note:'u=initial vel'},{name:'Velocity',eq:'v = u + at',note:''},{name:'v²-u²',eq:'v² = u² + 2as',note:''},{name:'Avg velocity',eq:'v_avg = (u+v)/2',note:''}]},
    { section: 'Laws of Motion', items: [{name:'Newton 2nd',eq:'F = ma',note:''},{name:'Momentum',eq:'p = mv',note:''},{name:'Impulse',eq:'J = FΔt',note:''},{name:'Friction',eq:'f = μN',note:''}]},
    { section: 'Electrostatics', items: [{name:'Coulomb',eq:'F = kq₁q₂/r²',note:'k=9×10⁹'},{name:'E-field',eq:'E = kQ/r²',note:''},{name:'Ohm\'s law',eq:'V = IR',note:''}]},
    { section: 'Energy & Work', items: [{name:'Work',eq:'W = F·d·cosθ',note:''},{name:'KE',eq:'KE = ½mv²',note:''},{name:'PE',eq:'PE = mgh',note:''}]},
  ],
  Chemistry: [
    { section: 'Mole Concept', items: [{name:'Moles',eq:'n = m/M',note:''},{name:'Ideal gas',eq:'PV = nRT',note:'R=8.314'},{name:'Molarity',eq:'M = n/V(L)',note:''},{name:'pH',eq:'pH = -log[H⁺]',note:''}]},
    { section: 'Kinetics', items: [{name:'Rate law',eq:'r = k[A]^m[B]^n',note:''},{name:'1st order',eq:'t₁/₂ = 0.693/k',note:''},{name:'Arrhenius',eq:'k = Ae^(-Ea/RT)',note:''}]},
    { section: 'Thermodynamics', items: [{name:'1st law',eq:'ΔU = q + w',note:''},{name:'Enthalpy',eq:'ΔH = ΔU + ΔngRT',note:''},{name:'Gibbs',eq:'ΔG = ΔH - TΔS',note:'ΔG<0 = spontaneous'}]},
  ],
  Maths: [
    { section: 'Calculus', items: [{name:'Chain rule',eq:'d/dx[f(g(x))] = f\'(g)·g\'',note:''},{name:'Product rule',eq:'d/dx[uv] = u\'v + uv\'',note:''},{name:'Int by parts',eq:'∫u dv = uv - ∫v du',note:''}]},
    { section: 'Trigonometry', items: [{name:'Pythagoras',eq:'sin²θ + cos²θ = 1',note:''},{name:'Double angle',eq:'sin2θ = 2sinθcosθ',note:''},{name:'Sum',eq:'sin(A±B) = sinAcosB ± cosAsinB',note:''}]},
    { section: 'Sequences', items: [{name:'AP nth',eq:'aₙ = a + (n-1)d',note:''},{name:'AP sum',eq:'Sₙ = n/2[2a+(n-1)d]',note:''},{name:'GP nth',eq:'aₙ = arⁿ⁻¹',note:''}]},
  ]
};
let _curSubj = 'Physics';
function showFormulas(subj) {
  _curSubj = subj;
  ['Physics', 'Chemistry', 'Maths'].forEach(s => {
    const id = 'ff-' + (s === 'Physics' ? 'phy' : s === 'Chemistry' ? 'chem' : 'math');
    const el = document.getElementById(id); if (!el) return;
    if (s === subj) { el.style.background = 'var(--teal)'; el.style.color = '#fff'; el.style.border = 'none'; }
    else { el.style.background = 'var(--surface2)'; el.style.color = 'var(--text-muted)'; el.style.border = '1px solid var(--border)'; }
  });
  const list = document.getElementById('formulaList'); if (!list) return;
  list.innerHTML = (FORMULAS[subj] || []).map(sec => `<div class="formula-section"><div class="formula-section-title" onclick="this.parentElement.classList.toggle('collapsed')">${sec.section}</div><div class="formula-items">${sec.items.map(f => `<div class="formula-card"><div class="formula-name">${f.name}</div><div class="formula-eq">${f.eq}</div>${f.note ? `<div class="formula-note">${f.note}</div>` : ''}</div>`).join('')}</div></div>`).join('');
}

// Flashcards
const FLASHCARDS = {
  Physics: [{q:'Newton\'s 3rd law',a:'Every action has an equal & opposite reaction.'},{q:'Escape velocity',a:'v_e = √(2gR) ≈ 11.2 km/s for Earth'},{q:'Ohm\'s law',a:'V = IR — current ∝ voltage at constant temperature'}],
  Chemistry: [{q:'Hund\'s rule',a:'Electrons occupy orbitals singly (same spin) before pairing.'},{q:'1st order half-life',a:'t₁/₂ = 0.693/k — independent of concentration'}],
  Maths: [{q:'Derivative of sin(x)',a:'cos(x)'},{q:'∫ eˣ dx',a:'eˣ + C'},{q:'Sum of first n naturals',a:'n(n+1)/2'}]
};
let _flashCards = [], _flashIdx = 0, _flashFlipped = false;
function startFlash(subj) {
  _flashCards = (FLASHCARDS[subj] || []).slice().sort(() => Math.random() - 0.5); _flashIdx = 0; _flashFlipped = false;
  document.getElementById('flashEmpty').style.display = 'none'; document.getElementById('flashCard').style.display = 'block'; document.getElementById('flashNav').style.display = 'block'; showFlashCard();
}
function showFlashCard() {
  _flashFlipped = false; const f = document.getElementById('flashFront'), b = document.getElementById('flashBack');
  if (f) f.style.display = 'block'; if (b) b.style.display = 'none';
  const q = document.getElementById('flashQ'); if (q) q.textContent = _flashCards[_flashIdx].q;
  const cnt = document.getElementById('flashCount'); if (cnt) cnt.textContent = (_flashIdx + 1) + '/' + _flashCards.length;
  const fc = document.getElementById('flashCard'); if (fc) fc.style.background = 'linear-gradient(135deg,var(--teal-dim),var(--teal))';
}
function flipFlash() {
  _flashFlipped = !_flashFlipped; const f = document.getElementById('flashFront'), b = document.getElementById('flashBack');
  if (f) f.style.display = _flashFlipped ? 'none' : 'block'; if (b) b.style.display = _flashFlipped ? 'block' : 'none';
  if (_flashFlipped) { const a = document.getElementById('flashA'); if (a) a.textContent = _flashCards[_flashIdx].a; const fc = document.getElementById('flashCard'); if (fc) fc.style.background = 'linear-gradient(135deg,#166534,#16a34a)'; }
  else { const fc = document.getElementById('flashCard'); if (fc) fc.style.background = 'linear-gradient(135deg,var(--teal-dim),var(--teal))'; }
}
function nextFlash() { _flashIdx = (_flashIdx + 1) % _flashCards.length; showFlashCard(); }
function prevFlash() { _flashIdx = (_flashIdx - 1 + _flashCards.length) % _flashCards.length; showFlashCard(); }

// Mistake Flashcards
const _mfc = { cards: [], idx: 0, flipped: false };
function buildMistakeCards(filter) {
  _mfc.cards = (filter === 'all' ? App.mistakes : App.mistakes.filter(m => m.subj === filter)).slice().sort(() => Math.random() - 0.5);
  _mfc.idx = 0; _mfc.flipped = false; renderMistakeCard();
}
function renderMistakeCard() {
  const el = document.getElementById('mfcCard'); if (!el) return;
  const nav = document.getElementById('mfcNav'), empty = document.getElementById('mfcEmpty'), counter = document.getElementById('mfcCounter');
  if (!_mfc.cards.length) { el.style.display = 'none'; if (nav) nav.style.display = 'none'; if (empty) empty.style.display = 'block'; if (counter) counter.textContent = ''; return; }
  el.style.display = 'block'; if (nav) nav.style.display = 'block'; if (empty) empty.style.display = 'none';
  const m = _mfc.cards[_mfc.idx], colors = { Physics: '#3d9bef', Chemistry: '#22c55e', Maths: '#f59e0b' }, col = colors[m.subj] || '#0ea5e9';
  _mfc.flipped = false; el.style.background = `linear-gradient(135deg,${col}22,${col}44)`; el.style.borderColor = col + '44';
  const mff = document.getElementById('mfcFront'), mfb = document.getElementById('mfcBack');
  if (mff) mff.style.display = 'block'; if (mfb) mfb.style.display = 'none';
  const mfq = document.getElementById('mfcQ'); if (mfq) mfq.innerHTML = `<span style="background:${col}22;color:${col};border:1px solid ${col}44;border-radius:6px;padding:2px 8px;font-size:0.6rem;font-weight:700;display:inline-block;margin-bottom:8px;">${m.subj} · ${m.type}</span><br><strong>${m.topic}</strong>${m.q ? `<br><span style="font-size:0.78rem;opacity:0.85;">${m.q}</span>` : ''}`;
  const mfa = document.getElementById('mfcA'); if (mfa) mfa.textContent = m.note || 'No note added.';
  if (counter) counter.textContent = (_mfc.idx + 1) + ' / ' + _mfc.cards.length;
}
function flipMistakeFlash() { if (!_mfc.cards.length) return; _mfc.flipped = !_mfc.flipped; const f = document.getElementById('mfcFront'), b = document.getElementById('mfcBack'); if (f) f.style.display = _mfc.flipped ? 'none' : 'block'; if (b) b.style.display = _mfc.flipped ? 'block' : 'none'; }
function nextMistakeFlash() { if (!_mfc.cards.length) return; _mfc.idx = (_mfc.idx + 1) % _mfc.cards.length; renderMistakeCard(); }
function prevMistakeFlash() { if (!_mfc.cards.length) return; _mfc.idx = (_mfc.idx - 1 + _mfc.cards.length) % _mfc.cards.length; renderMistakeCard(); }
function setMFCFilter(f, btn) {
  ['mfc-all','mfc-phy','mfc-chem','mfc-math'].forEach(id => { const el = document.getElementById(id); if (!el) return; el.style.background = 'var(--surface2)'; el.style.color = 'var(--text-muted)'; el.style.border = '1px solid var(--border)'; });
  if (btn) { btn.style.background = 'var(--teal)'; btn.style.color = '#fff'; btn.style.border = 'none'; }
  buildMistakeCards(f);
}

// Tools init
async function initToolsTab() {
  const ts = todayStr();
  if (!App.studyTime[ts] && App.user) {
    App.studyTime[ts] = await dbLoadStudyTime(App.user.uid, ts);
  }
  renderTimeTracker(); renderMistakes(); renderMocks(); renderGoalStreak();
  showFormulas('Physics'); buildMistakeCards('all'); updTgt(); updateNotifUI();
}

// ── Calendar ──────────────────────────────────────────────────
let curCalDate = new Date();
function changeMonth(dir) { curCalDate.setMonth(curCalDate.getMonth() + dir); renderCalendar(); }
function renderCalendar() {
  const grid = document.getElementById('calendarGrid'), monthYear = document.getElementById('calMonthYear');
  if (!grid || !monthYear) return;
  const year = curCalDate.getFullYear(), month = curCalDate.getMonth(), today_ = new Date();
  monthYear.textContent = curCalDate.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const firstDay = new Date(year, month, 1).getDay(), daysInMonth = new Date(year, month + 1, 0).getDate(), daysInPrevMonth = new Date(year, month, 0).getDate();
  let html = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => `<div class="cal-day-label">${d}</div>`).join('');
  const eventMap = {};
  App.entries.forEach(e => e.revisions.forEach(r => { const ds = toLocalDate(new Date(r.datetime)); if (!eventMap[ds]) eventMap[ds] = []; eventMap[ds].push({ ...r, topic: e.topic }); }));
  for (let i = firstDay; i > 0; i--) html += `<div class="cal-date other-month">${daysInPrevMonth - i + 1}</div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${p(month + 1)}-${p(d)}`, isToday = toLocalDate(today_) === ds, events = eventMap[ds] || [];
    html += `<div class="cal-date ${isToday ? 'today' : ''}" onclick="showDayDetails('${ds}')">${d}<div class="cal-dot-wrap">${events.slice(0, 3).map(() => '<div class="cal-event-dot"></div>').join('')}</div></div>`;
  }
  const totalCells = firstDay + daysInMonth, nextDays = (7 - (totalCells % 7)) % 7;
  for (let i = 1; i <= nextDays; i++) html += `<div class="cal-date other-month">${i}</div>`;
  grid.innerHTML = html;
}
function showDayDetails(dateStr) {
  document.querySelectorAll('.cal-date').forEach(el => el.classList.remove('selected'));
  const target = Array.from(document.querySelectorAll('.cal-date:not(.other-month)')).find(el => el.textContent.trim().split('\n')[0].trim() === String(parseInt(dateStr.split('-')[2])));
  if (target) target.classList.add('selected');
  const detWrap = document.getElementById('calDayDetails'), detCont = document.getElementById('calDetailsContent');
  if (!detWrap || !detCont) return;
  const dayEvents = [];
  App.entries.forEach(e => e.revisions.forEach(r => { if (toLocalDate(new Date(r.datetime)) === dateStr) dayEvents.push({ topic: e.topic, label: r.label, time: new Date(r.datetime).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) }); }));
  detWrap.style.display = 'block';
  detCont.innerHTML = dayEvents.length ? dayEvents.map(ev => `<div class="card" style="margin-bottom:8px;padding:12px;"><div style="display:flex;justify-content:space-between;align-items:center;"><div><div style="font-size:0.85rem;font-weight:600;">${ev.topic}</div><div style="font-size:0.65rem;color:var(--text-dim);">${ev.time}</div></div><span class="iv-tag long">${ev.label}</span></div></div>`).join('') : '<div class="empty-state" style="padding:20px;"><p>No revisions for this day.</p></div>';
  setTimeout(() => detWrap.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
}

// ── Offline banner ────────────────────────────────────────────
(function() {
  const b = document.createElement('div');
  b.id = '_ob'; b.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;background:#dc2626;color:#fff;text-align:center;padding:8px;font-size:0.75rem;font-weight:600;z-index:9999;pointer-events:none;';
  b.textContent = 'No internet — data will sync when reconnected';
  document.body.appendChild(b);
  function chk() { b.style.display = navigator.onLine ? 'none' : 'block'; }
  window.addEventListener('online', chk); window.addEventListener('offline', chk); chk();
})();

// ── DOMContentLoaded ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  renderQ(); updatePomoDisplay(); showFormulas('Physics');
  document.getElementById('mistakeModal')?.addEventListener('click', e => { if (e.target === document.getElementById('mistakeModal')) closeMistakeForm(); });
  document.getElementById('mockModal')?.addEventListener('click', e => { if (e.target === document.getElementById('mockModal')) closeMockForm(); });
});
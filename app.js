// ═══════════════════════════════════════════════════════════════
// app.js — Unified Study Tracker Logic v5.0
// ═══════════════════════════════════════════════════════════════

// ── Firebase Config ──
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBRw3GxukFyPEcjOY-0FIsXBk2p-7TQivM",
  authDomain: "study-tracker-52de8.firebaseapp.com",
  projectId: "study-tracker-52de8",
  storageBucket: "study-tracker-52de8.firebasestorage.app",
  messagingSenderId: "183173939785",
  appId: "1:183173939785:web:5fc5eee2f86b87c356b598"
};
const ADMIN_EMAILS = ["darshanderkar20@gmail.com", "derkardarshan@gmail.com"];

// ── App State ──
const App = {
  user: null,
  entries: [],
  dailyData: {}, // { 'YYYY-MM-DD': { done:{key:true}, ratings:{key:'easy'} } }
  studyTime: {},
  mistakes: [],
  mocks: [],
  examDates: { mains: null, adv: null },
  studyTarget: 6,
  _unsubs: [],
  currentAddSubject: [] // Multi-select array
};
const p = n => String(n).padStart(2, '0');
const toLocalDate = d => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
const todayStr = () => toLocalDate(new Date());

const showToast = msg => {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1e293b;color:#fff;padding:12px 24px;border-radius:12px;font-size:0.85rem;z-index:9999;box-shadow:0 10px 30px rgba(0,0,0,0.2);animation:fadeUp 0.3s forwards;';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
};

// ── Firebase Init ──
firebase.initializeApp(FIREBASE_CONFIG);
const _auth = firebase.auth();
const _db = firebase.firestore();

// ── Auth Logic ──
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
  const target = document.getElementById(id);
  if (target) target.style.display = (id === 'appScreen' || id === 'pendingScreen') ? 'flex' : 'block';
}

// ── Branding Sync ──
function initBrandingSync() {
  _db.collection('site_settings').doc('branding').onSnapshot(doc => {
    if (doc.exists) {
      const data = doc.data();
      if (data.logo_url) {
        const logo = document.getElementById('loginLogo');
        if (logo) logo.src = data.logo_url;
        // Also update any other logos
        document.querySelectorAll('.app-logo').forEach(el => el.src = data.logo_url);
      }
      if (data.primary_color) {
        document.documentElement.style.setProperty('--accent', data.primary_color);
        document.documentElement.style.setProperty('--accent-glow', data.primary_color + '40');
      }
    }
  });
}

function showAuthTab(tab) {
  const login = document.getElementById('loginForm');
  const reg = document.getElementById('registerForm');
  if (tab === 'login') { login.style.display = 'block'; reg.style.display = 'none'; }
  else { login.style.display = 'none'; reg.style.display = 'block'; }
}

async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const pass = document.getElementById('loginPass').value;
  if (!email || !pass) return showToast('Please enter both email and password.');
  try { 
    await _auth.signInWithEmailAndPassword(email, pass); 
    // Securely store for Calendar SSO (Session only)
    sessionStorage.setItem('sh_email', email);
    sessionStorage.setItem('sh_pass', btoa(pass)); // Basic obscurity
  }
  catch(e) { showToast(e.message); }
}

async function doRegister() {
  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const phone = document.getElementById('regPhone').value.trim();
  const pass = document.getElementById('regPass').value;
  if (!name || !email || !phone || !pass) return showToast('Please fill all fields.');
  try {
    const cred = await _auth.createUserWithEmailAndPassword(email, pass);
    await cred.user.updateProfile({ displayName: name });
    await _db.collection('users').doc(cred.user.uid).set({
      name, email, phone, status: 'pending', createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    // Duplicate to accessRequests for admin visibility
    await _db.collection('accessRequests').doc(cred.user.uid).set({
      name, email, phone, status: 'pending', createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    showScreen('pendingScreen');
  } catch(e) { showToast(e.message); }
}

function doLogout() {
  if (!confirm('Are you sure you want to sign out?')) return;
  sessionStorage.removeItem('sh_email');
  sessionStorage.removeItem('sh_pass');
  _auth.signOut();
  window.location.reload();
}

function setupGlobalListeners() {
  // Real-time site settings (logo, etc)
  _db.collection('settings').doc('branding')
    .onSnapshot(doc => {
      if (doc.exists) {
        const data = doc.data();
        const finalLogo = data.logo_url || data.logoUrl;
        if (finalLogo) {
          const l1 = document.getElementById('loginLogo');
          const l2 = document.getElementById('sidebarLogo');
          if (l1) l1.src = finalLogo;
          if (l2) l2.src = finalLogo;
        }
      }
    });

  // Real-time exam dates
  if (App.user) {
    _db.collection('users').doc(App.user.uid).collection('settings').doc('examdates')
      .onSnapshot(doc => {
        if (doc.exists) App.examDates = doc.data();
        renderCountdown();
      });
  }
}


// ── Auth Logic ──

_auth.onAuthStateChanged(async user => {
  loadTheme();
  if (!user) {
    // Clean up any previous listeners
    App._unsubs.forEach(unsub => unsub());
    App._unsubs = [];
    return showScreen('authScreen');
  }
  App.user = user;
  
  // Real-time listener for user status
  const unsubStatus = _db.collection('users').doc(user.uid)
    .onSnapshot(doc => {
      if (doc.exists) {
        const data = doc.data();
        if (data.status === 'approved' || ADMIN_EMAILS.includes(user.email)) {
          if (data.status !== 'approved') {
            _db.collection('users').doc(user.uid).set({ status: 'approved' }, { merge: true });
          }
          // Only init if not already on app screen
          if (document.getElementById('appScreen').style.display !== 'flex') {
            _db.collection('users').doc(user.uid).set({
              lastLogin: firebase.firestore.FieldValue.serverTimestamp(),
              lastDevice: navigator.userAgent,
              loginCount: firebase.firestore.FieldValue.increment(1)
            }, { merge: true }).catch(() => {});
            initApp();
          }
        } else {
          showScreen('pendingScreen');
        }
      } else {
        showScreen('pendingScreen');
      }
    });
  App._unsubs.push(unsubStatus);
});

// ── App Core ──
async function initApp() {
  showScreen('appScreen');
  updateClock(); setInterval(updateClock, 1000);
  const name = App.user.displayName || App.user.email;
  document.getElementById('userAvatar').textContent = name[0].toUpperCase();
  document.getElementById('menuName').textContent = name;
  document.getElementById('menuEmail').textContent = App.user.email;
  
  setupGlobalListeners(); // New robust real-time settings
  setupListeners();
  syncInputTime();
}

function setupListeners() {
  // Real-time entries
  const unsub = _db.collection('users').doc(App.user.uid).collection('entries')
    .onSnapshot(snap => {
      // Restore previous data by removing server-side sort (filters out docs missing the field)
      // and sorting locally instead.
      App.entries = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => {
          const tA = a.createdAt?.seconds || a.timestamp?.seconds || 0;
          const tB = b.createdAt?.seconds || b.timestamp?.seconds || 0;
          return tB - tA;
        });
      refreshActivePage();
      updateTodayBadge();
      computeStreak();
      renderPerformanceScore(); // Update score when entries change
    });
  App._unsubs.push(unsub);

  // Historical Progress Listener (fetches all completion days for accuracy)
  const unsubDaily = _db.collection('users').doc(App.user.uid).collection('daily')
    .onSnapshot(snap => {
      snap.forEach(doc => {
        App.dailyData[doc.id] = doc.data();
      });
      renderPerformanceScore(); // Live update dashboard score
      if (document.getElementById('page-today').classList.contains('active')) renderToday();
    });
  App._unsubs.push(unsubDaily);

  // Load mistakes
  _db.collection('users').doc(App.user.uid).collection('data').doc('mistakes')
    .onSnapshot(snap => {
      App.mistakes = snap.exists ? (snap.data().payload || []) : [];
      if (document.getElementById('page-tools')?.classList.contains('active')) renderMistakes();
    });

  // Load mock tests
  _db.collection('users').doc(App.user.uid).collection('mocks')
    .orderBy('date', 'desc')
    .onSnapshot(snap => {
      App.mocks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (document.getElementById('page-tools')?.classList.contains('active')) renderMockTests();
    });

  // Load study time
  _db.collection('users').doc(App.user.uid).collection('studytime')
    .orderBy('date', 'desc').limit(30)
    .onSnapshot(snap => {
      App.studyTime = {};
      snap.docs.forEach(d => { App.studyTime[d.data().date] = d.data(); });
      if (document.getElementById('page-tools')?.classList.contains('active')) renderStudyTime();
    });
}

async function loadSettings() {
  try {
    const doc = await _db.collection('users').doc(App.user.uid).collection('settings').doc('examdates').get();
    if (doc.exists) App.examDates = doc.data();
    renderCountdown();
  } catch(e) {}
}

// ── UI Interactivity ──
function loadTheme() {
  const saved = localStorage.getItem('theme') || 'dark-mode';
  document.body.classList.remove('light-mode', 'dark-mode');
  document.body.classList.add(saved);
  const btn = document.getElementById('themeBtn');
  if (btn) btn.textContent = saved === 'dark-mode' ? '🌙' : '☀️';
}

function toggleTheme() {
  const isDark = document.body.classList.contains('dark-mode');
  const next = isDark ? 'light-mode' : 'dark-mode';
  document.body.classList.remove('light-mode', 'dark-mode');
  document.body.classList.add(next);
  localStorage.setItem('theme', next);
  const btn = document.getElementById('themeBtn');
  if (btn) btn.textContent = next === 'dark-mode' ? '🌙' : '☀️';
}

function switchTab(name) {
  document.querySelectorAll('.page').forEach(pg => pg.classList.remove('active'));
  document.querySelectorAll('.nav-link, .bottom-nav a').forEach(el => el.classList.remove('active'));
  
  document.getElementById('page-' + name)?.classList.add('active');
  document.getElementById('nav-' + name)?.classList.add('active');
  document.getElementById('nav-' + name + '-mob')?.classList.add('active');
  
  if (name === 'dash') renderDashboard();
  if (name === 'today') renderToday();
  if (name === 'log') renderLog();
  if (name === 'tools') initTools();
  if (name === 'calendar') renderNativeCalendar();
}

function refreshActivePage() {
  const active = document.querySelector('.page.active');
  if (!active) return;
  const name = active.id.replace('page-', '');
  switchTab(name);
}

function updateClock() {
  const now = new Date();
  const time = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  const date = now.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  const timeEl = document.getElementById('clockTime');
  const dateEl = document.getElementById('clockDate');
  if (timeEl) timeEl.textContent = time;
  if (dateEl) dateEl.textContent = date;
}

function syncInputTime() {
  const now = new Date();
  document.getElementById('studyDate').value = toLocalDate(now);
  document.getElementById('studyTime').value = `${p(now.getHours())}:${p(now.getMinutes())}`;
}

// ── Tracker Logic ──
const INTERVALS = [
  { label: 'Immediate', mins: 0, type: 'short' },
  { label: '12 hrs', mins: 720, type: 'short' },
  { label: 'Day 1', mins: 1440, type: 'long' },
  { label: 'Day 2', mins: 2880, type: 'long' },
  { label: 'Day 4', mins: 5760, type: 'long' },
  { label: 'Day 7', mins: 10080, type: 'long' },
  { label: 'Day 15', mins: 21600, type: 'long' },
  { label: 'Day 30', mins: 43200, type: 'long' }
];

function selectSubjectChip(subject, el) {
  if (!Array.isArray(App.currentAddSubject)) App.currentAddSubject = [];
  
  if (App.currentAddSubject.includes(subject)) {
    App.currentAddSubject = App.currentAddSubject.filter(s => s !== subject);
    el.classList.remove('active');
  } else {
    App.currentAddSubject.push(subject);
    el.classList.add('active');
  }
}

async function addEntry() {
  const topic = document.getElementById('topicInput').value.trim();
  const dateStr = document.getElementById('studyDate').value;
  const timeStr = document.getElementById('studyTime').value;
  if (!topic) return showToast('Please enter a topic!');

  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const base = new Date(y, m - 1, d, h, mi);
  
  const revisions = INTERVALS.map(iv => ({
    label: iv.label,
    datetime: new Date(base.getTime() + iv.mins * 60000).toISOString()
  }));

  App.pendingEntry = { 
    id: Date.now(), 
    topic, 
    dateStr, 
    timeStr, 
    revisions,
    subject: App.currentAddSubject 
  };
  
  showResult(App.pendingEntry);
}

function showResult(entry) {
  const rc = document.getElementById('resultCard');
  const title = document.getElementById('resultTopic');
  const subj = document.getElementById('resultSubj');
  const list = document.getElementById('intervalsList');
  
  rc.style.display = 'block';
  title.textContent = entry.topic;
  const subjects = Array.isArray(entry.subject) ? entry.subject : (entry.subject ? [entry.subject] : ['General']);
  subj.textContent = subjects.join(', ') || 'General';
  subj.style.color = subjects.length === 1 ? (subjects[0] === 'Physics' ? 'var(--primary)' : subjects[0] === 'Chemistry' ? 'var(--accent)' : 'var(--green)') : 'var(--primary)';

  list.innerHTML = entry.revisions.map((r, i) => `
    <div class="result-item" style="display:flex; justify-content:space-between; padding:12px 16px; background:rgba(255,255,255,0.02); border-radius:10px; font-size:0.85rem; border:1px solid var(--border); animation-delay: ${i * 0.05}s;">
      <span style="font-weight:700; color:var(--primary);">${r.label}</span>
      <span style="color:var(--text-dim);">${new Date(r.datetime).toLocaleDateString(undefined, {month:'short', day:'numeric'})} • ${new Date(r.datetime).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
    </div>
  `).join('');
  
  rc.scrollIntoView({ behavior: 'smooth' });
}

async function savePendingEntry() {
  if (!App.pendingEntry) return;
  const btn = document.getElementById('addToCalIcsBtn');
  btn.disabled = true; btn.textContent = 'Saving to Firestore...';
  try {
    await _db.collection('users').doc(App.user.uid).collection('entries').doc(String(App.pendingEntry.id))
      .set({ ...App.pendingEntry, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    
    // Reset button state for next use
    btn.disabled = false;
    btn.textContent = 'Save to Cloud Firestore';
    
    showToast('🚀 Topic synced to cloud!');
    document.getElementById('resultCard').style.display = 'none';
    document.getElementById('topicInput').value = '';
    App.pendingEntry = null;
    App.currentAddSubject = [];
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    
    // Switch to Today tab to see the result if applicable
    setTimeout(() => switchTab('today'), 800);
  } catch(e) { 
    showToast(e.message); 
    btn.disabled = false; 
    btn.textContent = 'Save to Cloud Firestore'; 
  }
}

function downloadICS() {
  const entry = App.pendingEntry;
  if (!entry) return;

  const formatDate = (date) => {
    const d = new Date(date);
    return d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  };

  let icsLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Nishchay Academy//Study Tracker//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH"
  ];

  entry.revisions.forEach(r => {
    const start = new Date(r.datetime);
    const end = new Date(start.getTime() + 60 * 60 * 1000); // 1 hour duration
    
    icsLines.push("BEGIN:VEVENT");
    icsLines.push(`UID:${entry.id}_${r.label.replace(/\s+/g, "_")}@nishchayacademy.pwa`);
    icsLines.push(`DTSTAMP:${formatDate(new Date())}`);
    icsLines.push(`DTSTART:${formatDate(start)}`);
    icsLines.push(`DTEND:${formatDate(end)}`);
    icsLines.push(`SUMMARY:${entry.topic} (${r.label} Revision)`);
    icsLines.push(`DESCRIPTION:Revision session for ${entry.topic} - Stage: ${r.label}. Logged via Nishchay Student Portal.`);
    icsLines.push("STATUS:CONFIRMED");
    icsLines.push("SEQUENCE:0");
    icsLines.push("BEGIN:VALARM");
    icsLines.push("TRIGGER:-PT15M");
    icsLines.push("ACTION:DISPLAY");
    icsLines.push("DESCRIPTION:Reminder");
    icsLines.push("END:VALARM");
    icsLines.push("END:VEVENT");
  });

  icsLines.push("END:VCALENDAR");

  const icsContent = icsLines.join("\r\n");
  const fileName = `${entry.topic.replace(/\s+/g, "_")}_Revision_Plan.ics`;
  const file = new File([icsContent], fileName, { type: "text/calendar;charset=utf-8" });

  // Web Share API Implementation (Mobile / Safari native prompt)
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({
      files: [file],
      title: "Revision Calendar",
      text: "Import your revision milestones"
    }).then(() => showToast("📅 Calendar sync launched!"))
      .catch(err => {
        // If user aborts share, we just fail silently or do fallback download
        if (err.name !== 'AbortError') fallbackDownload(file, fileName);
      });
  } else {
    // Clean Fallback for Chrome/Desktop (No sketchy data URIs)
    fallbackDownload(file, fileName);
  }
}

function fallbackDownload(file, fileName) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  showToast("📅 File downloaded! Click it in your tray to add to your calendar.");
}

function openInGoogleCalendar() {
  const entry = App.pendingEntry;
  if (!entry) return;

  // We take the first revision as the primary example, or just open a generic prompt?
  // Actually, providing a bulk export to Google is harder via URL, but individual ones work.
  // For now, let's keep the focus on the ICS which handles all 8 at once.
}

// ── UI Rendering ──

function renderToday() {
  const ts = todayStr();
  const daily = App.dailyData[ts] || { done: {}, ratings: {} };
  // Always ensure ratings exists (safety guard for old Firestore docs)
  if (!daily.ratings) daily.ratings = {};
  const items = getTodayItems();
  const c = document.getElementById('todayContent');
  if (!items.length) {
    c.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-dim);">🎉 No revisions scheduled for today!</div>';
    return;
  }
  c.innerHTML = items.map(item => {
    const isDone = !!(daily.done && daily.done[item.key]);
    const rating = (daily.ratings && daily.ratings[item.key]) || '';
    const badgeHtml = isDone
      ? `<div class="rev-badge ${rating === 'easy' ? 'rev-badge-easy' : 'rev-badge-hard'}">${rating === 'easy' ? '🍃 Easy' : '🔥 Hard'}</div>`
      : `<button onclick="rateRevision(this,'${item.key}','easy')" class="btn-rate btn-rate-easy"><span>🍃</span>Easy</button>
         <button onclick="rateRevision(this,'${item.key}','hard')" class="btn-rate btn-rate-hard"><span>🔥</span>Hard</button>`;
    return `
      <div class="revision-item${isDone ? ' revision-done' : ''}" data-key="${item.key}">
        <div class="rev-icon">${isDone ? '✅' : '⏳'}</div>
        <div class="rev-body">
          <div class="rev-topic">${item.topic}</div>
          <div class="rev-label"><span class="rev-dot"></span>${item.label}</div>
        </div>
        <div class="revision-actions">${badgeHtml}</div>
      </div>`;
  }).join('');
}

function getTodayItems(pendingOnly = false) {
  const ts = todayStr();
  const daily = App.dailyData[ts] || { done: {}, ratings: {} };
  if (!daily.done) daily.done = {};
  const items = [];
  App.entries.forEach(e => {
    e.revisions.forEach(r => {
      if (toLocalDate(new Date(r.datetime)) === ts) {
        const key = `${e.id}_${r.label}`;
        if (!pendingOnly || !daily.done[key]) {
          items.push({ topic: e.topic, label: r.label, key, id: e.id });
        }
      }
    });
  });
  return items;
}

async function rateRevision(btn, key, rating) {
  // Immediately update UI before Firestore round-trip
  const row = btn.closest('.revision-item');
  if (row) {
    row.classList.add('revision-done');
    row.querySelector('.rev-icon').textContent = '✅';
    const topic = row.querySelector('.rev-topic');
    if (topic) topic.style.color = 'var(--text-muted)';
    const actions = row.querySelector('.revision-actions');
    if (actions) {
      actions.innerHTML = `<div class="rev-badge ${rating === 'easy' ? 'rev-badge-easy' : 'rev-badge-hard'}">${rating === 'easy' ? '🍃 Easy' : '🔥 Hard'}</div>`;
    }
  }
  // Update App state immediately so badge persists across re-renders
  const ts = todayStr();
  if (!App.dailyData[ts]) App.dailyData[ts] = { done: {}, ratings: {} };
  if (!App.dailyData[ts].ratings) App.dailyData[ts].ratings = {};
  App.dailyData[ts].done[key] = true;
  App.dailyData[ts].ratings[key] = rating;

  try {
    const ref = _db.collection('users').doc(App.user.uid).collection('daily').doc(ts);
    await ref.set({ done: { [key]: true }, ratings: { [key]: rating } }, { merge: true });
    showToast(`Marked as ${rating === 'easy' ? '🍃 Easy' : '🔥 Hard'}!`);
  } catch (e) {
    showToast('Failed to save. Try again.');
  }
}


function renderLog() {
  const c = document.getElementById('logContainer');
  const filtered = App.searchQuery ? App.entries.filter(e => e.topic.toLowerCase().includes(App.searchQuery.toLowerCase())) : App.entries;
  
  if (!filtered.length) {
    c.innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-dim);">No topics found.</div>';
    return;
  }

  c.innerHTML = filtered.map(e => `
    <div class="card" style="display:flex; justify-content:space-between; align-items:center; padding:16px 20px;">
      <div>
        <div style="font-weight:600; color:var(--text);">${e.topic}</div>
        <div style="font-size:0.75rem; color:var(--text-dim);">
          ${Array.isArray(e.subject) ? e.subject.join(', ') : e.subject} • ${new Date(e.dateStr).toLocaleDateString()}
        </div>
      </div>
      <button onclick="deleteEntry('${e.id}')" class="btn-delete-log">✕</button>
    </div>
  `).join('');
}

async function deleteEntry(id) {
  if (!confirm('Are you sure you want to delete this topic?')) return;
  await _db.collection('users').doc(App.user.uid).collection('entries').doc(id).delete();
  showToast('Topic deleted.');
}

// ── Pomodoro Timer ──
let pomoInterval = null;
let pomoRunning = false;
let pomoSecondsLeft = 25 * 60;
let pomoDuration = 25 * 60;

function setPomoMode(mins, label) {
  if (pomoInterval) { clearInterval(pomoInterval); pomoInterval = null; pomoRunning = false; }
  pomoDuration = pomoSecondsLeft = mins * 60;
  updatePomoUI();
  document.getElementById('pomoLabel').textContent = label;
  document.getElementById('pomoStatusF').textContent = label;
}

function addPomoTime(mins) {
  pomoSecondsLeft = Math.min(60 * 60, pomoSecondsLeft + (mins * 60));
  pomoDuration = pomoSecondsLeft; // Update base duration if adjusted
  updatePomoUI();
  showToast(`⏰ Added ${mins}m (Total: ${Math.floor(pomoSecondsLeft/60)}m)`);
}

function updatePomoUI() {
  const m = Math.floor(pomoSecondsLeft / 60);
  const s = pomoSecondsLeft % 60;
  const timeStr = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  document.getElementById('pomoTime').textContent = timeStr;
  document.getElementById('pomoTimeF').textContent = timeStr;
  const btn = document.getElementById('pomoStartBtn');
  const btnF = document.getElementById('pomoStartBtnF');
  const txt = pomoRunning ? '⏸ Pause' : (pomoSecondsLeft === pomoDuration ? '▶ Start' : '▶ Resume');
  if (btn) btn.textContent = txt;
  if (btnF) btnF.textContent = txt;
}

function toggleTimerFullScreen() {
  const el = document.getElementById('pomoFullscreen');
  if (!el) return;
  el.classList.toggle('active');
  updatePomoUI();
}

function startPomo() {
  const btn = document.getElementById('pomoStartBtn');
  if (pomoRunning) {
    clearInterval(pomoInterval); pomoInterval = null; pomoRunning = false;
    btn.textContent = '▶ Resume';
  } else {
    pomoRunning = true;
    btn.textContent = '⏸ Pause';
    pomoInterval = setInterval(() => {
      pomoSecondsLeft--;
      updatePomoUI();
      if (pomoSecondsLeft <= 0) {
        clearInterval(pomoInterval); pomoInterval = null; pomoRunning = false;
        updatePomoUI();
        pomoSecondsLeft = pomoDuration;
        showToast('🎉 Session complete! Take a break.');
        // Audio alert
        try {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const osc = ctx.createOscillator(); osc.connect(ctx.destination);
          osc.frequency.setValueAtTime(880, ctx.currentTime);
          osc.start(); osc.stop(ctx.currentTime + 0.5);
        } catch(e) {}
      }
    }, 1000);
  }
}

// ── Questions Attempted ──
async function logQuestionsAttempted() {
  const count = parseInt(document.getElementById('qAttemptedInput')?.value);
  const subj = document.getElementById('qSubjectSelect')?.value;
  if (!count || count < 1) return showToast('Enter a valid count');
  const ts = todayStr();
  await _db.collection('users').doc(App.user.uid).collection('daily').doc(ts)
    .set({ questionsAttempted: firebase.firestore.FieldValue.increment(count), lastSubject: subj }, { merge: true });
  document.getElementById('qAttemptedInput').value = '';
  showToast(`✅ Logged ${count} questions for ${subj}`);
}

// ── Study Time ──
async function logStudyTime() {
  const hours = parseFloat(document.getElementById('studyHoursInput')?.value);
  const subj = document.getElementById('studySubjectSelect')?.value;
  if (!hours || hours <= 0) return showToast('Enter valid hours');
  const ts = todayStr();
  await _db.collection('users').doc(App.user.uid).collection('studytime').doc(ts).set({
    date: ts, subject: subj, hours: firebase.firestore.FieldValue.increment(hours)
  }, { merge: true });
  document.getElementById('studyHoursInput').value = '';
  showToast(`✅ Logged ${hours}h of ${subj}`);
}

function renderStudyTime() {
  const c = document.getElementById('studyTimeList');
  if (!c) return;
  const entries = Object.values(App.studyTime).slice(0, 7);
  if (!entries.length) { c.innerHTML = '<p style="color:var(--text-dim);text-align:center;padding:20px;">No study time logged yet.</p>'; return; }
  c.innerHTML = entries.map(e => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);">
      <div><div style="font-weight:600;font-size:0.85rem;">${e.date}</div><div style="font-size:0.7rem;color:var(--text-dim);">${e.subject}</div></div>
      <div style="font-size:1.2rem;font-weight:800;color:var(--teal);">${typeof e.hours === 'number' ? e.hours.toFixed(1) : e.hours}h</div>
    </div>`).join('');
}

// ── Mock Test Tracker ──
async function saveMockTest() {
  const score = parseFloat(document.getElementById('mockScore')?.value);
  const maxScore = parseFloat(document.getElementById('mockMaxScore')?.value) || 300;
  const testName = document.getElementById('mockName')?.value?.trim();
  if (!score || !testName) return showToast('Fill all mock test fields');
  await _db.collection('users').doc(App.user.uid).collection('mocks').add({
    date: todayStr(), score, maxScore, testName,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  document.getElementById('mockScore').value = '';
  document.getElementById('mockName').value = '';
  document.getElementById('mockModal').classList.remove('active');
  showToast('📊 Mock test logged!');
}

function renderMockTests() {
  const c = document.getElementById('mockList');
  if (!c) return;
  if (!App.mocks.length) { c.innerHTML = '<p style="color:var(--text-dim);text-align:center;padding:20px;">No mock tests logged yet.</p>'; return; }
  c.innerHTML = App.mocks.slice(0, 10).map(m => {
    const pct = Math.round((m.score / m.maxScore) * 100);
    const color = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--accent)' : 'var(--red)';
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--border);">
      <div><div style="font-weight:600;font-size:0.85rem;">${m.testName}</div><div style="font-size:0.7rem;color:var(--text-dim);">${m.date}</div></div>
      <div style="text-align:right;"><div style="font-size:1.1rem;font-weight:800;color:${color};">${m.score}/${m.maxScore}</div><div style="font-size:0.65rem;color:${color};">${pct}%</div></div>
    </div>`;
  }).join('');
}

// ── Flashcards ──
const FLASHCARDS = {
  Physics: [
    {q: 'Newton\'s 2nd Law', a: 'F = ma'},
    {q: 'Work-Energy Theorem', a: 'W = ΔKE = ½mv² - ½mu²'},
    {q: 'Coulomb\'s Law', a: 'F = kq₁q₂/r²'},
    {q: 'Ohm\'s Law', a: 'V = IR'},
    {q: 'Snell\'s Law', a: 'n₁sinθ₁ = n₂sinθ₂'},
  ],
  Chemistry: [
    {q: 'Ideal Gas Law', a: 'PV = nRT'},
    {q: 'Mole Concept', a: 'n = m/M = N/Nₐ'},
    {q: 'pH formula', a: 'pH = -log[H⁺]'},
    {q: 'Nernst Equation', a: 'E = E° - (RT/nF)lnQ'},
    {q: 'de Broglie', a: 'λ = h/mv'},
  ],
  Maths: [
    {q: 'Quadratic Formula', a: 'x = (-b ± √(b²-4ac)) / 2a'},
    {q: 'sin²x + cos²x', a: '= 1'},
    {q: 'Integration of eˣ', a: '∫eˣ dx = eˣ + C'},
    {q: 'Sum of AP', a: 'Sₙ = n/2 × (2a + (n-1)d)'},
    {q: 'Area of Triangle', a: '= ½|x₁(y₂-y₃) + x₂(y₃-y₁) + x₃(y₁-y₂)|'},
  ]
};

let flashcardIdx = 0;
let flashcardSubj = 'Physics';
let flashcardFlipped = false;

function showFlashcard(subj) {
  flashcardSubj = subj || flashcardSubj;
  flashcardIdx = 0; flashcardFlipped = false;
  renderFlashcard();
}

function renderFlashcard() {
  const cards = FLASHCARDS[flashcardSubj];
  const card = cards[flashcardIdx];
  const fc = document.getElementById('flashcardFace');
  const counter = document.getElementById('flashcardCounter');
  if (!fc || !card) return;
  fc.innerHTML = flashcardFlipped
    ? `<div style="font-size:1.8rem;font-weight:800;color:var(--primary);font-family:serif;">${card.a}</div><div style="font-size:0.7rem;color:var(--text-dim);margin-top:8px;">Answer</div>`
    : `<div style="font-size:1rem;font-weight:600;color:var(--text);">${card.q}</div><div style="font-size:0.7rem;color:var(--text-dim);margin-top:8px;">Tap to reveal</div>`;
  if (counter) counter.textContent = `${flashcardIdx + 1} / ${cards.length}`;
}

function flipFlashcard() { flashcardFlipped = !flashcardFlipped; renderFlashcard(); }
function nextFlashcard() { const c = FLASHCARDS[flashcardSubj]; flashcardIdx = (flashcardIdx + 1) % c.length; flashcardFlipped = false; renderFlashcard(); }
function prevFlashcard() { const c = FLASHCARDS[flashcardSubj]; flashcardIdx = (flashcardIdx - 1 + c.length) % c.length; flashcardFlipped = false; renderFlashcard(); }

// ── Streak ──
function computeStreak() {
  const dates = new Set(App.entries.map(e => e.dateStr));
  let streak = 0;
  let d = new Date();
  while (true) {
    const ds = toLocalDate(d);
    if (dates.has(ds)) { streak++; d.setDate(d.getDate() - 1); }
    else break;
  }
  App.streak = streak;
  const el = document.getElementById('perfStreak');
  if (el) el.textContent = streak;
}

function initTools() {
  renderMistakes();
  renderMockTests();
  renderStudyTime();
  showFormulas('Physics');
  showFlashcard('Physics');
  initFormulaAudioDB();
}

// ═══════════════════════════════════════════════════════════════
// PHASE 4 — Audio Formula Recording (IndexedDB + MediaRecorder)
// ═══════════════════════════════════════════════════════════════
let formulaAudioDB = null;
let currentRecordingKey = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

function initFormulaAudioDB() {
  const req = indexedDB.open('formulaAudio', 1);
  req.onupgradeneeded = e => {
    e.target.result.createObjectStore('recordings', { keyPath: 'key' });
  };
  req.onsuccess = e => { formulaAudioDB = e.target.result; };
}

function selectFormulaForRecording(key, label) {
  currentRecordingKey = key;
  document.getElementById('selectedFormulaLabel').textContent = label;
  document.getElementById('audioRecorderPanel').style.display = 'block';
  // Check if recording exists
  checkFormulaAudioExists(key);
}

function checkFormulaAudioExists(key) {
  if (!formulaAudioDB) return;
  const tx = formulaAudioDB.transaction('recordings', 'readonly');
  const store = tx.objectStore('recordings');
  const req = store.get(key);
  req.onsuccess = e => {
    const exists = !!e.target.result;
    document.getElementById('playAudioBtn').disabled = !exists;
    document.getElementById('deleteAudioBtn').disabled = !exists;
  };
}

async function toggleRecording() {
  if (isRecording) {
    // Stop recording
    mediaRecorder.stop();
  } else {
    // Start recording
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        saveFormulaAudio(blob);
        stream.getTracks().forEach(t => t.stop());
        document.getElementById('recordBtn').textContent = '🔴 Start Recording';
        document.getElementById('recordingWave').style.display = 'none';
        isRecording = false;
      };
      mediaRecorder.start();
      isRecording = true;
      document.getElementById('recordBtn').textContent = '⏹ Stop Recording';
      document.getElementById('recordingWave').style.display = 'block';
    } catch (e) {
      showToast('Microphone access denied.');
    }
  }
}

function saveFormulaAudio(blob) {
  if (!formulaAudioDB || !currentRecordingKey) return;
  const tx = formulaAudioDB.transaction('recordings', 'readwrite');
  tx.objectStore('recordings').put({ key: currentRecordingKey, blob });
  tx.oncomplete = () => {
    showToast('✅ Audio saved!');
    document.getElementById('playAudioBtn').disabled = false;
    document.getElementById('deleteAudioBtn').disabled = false;
  };
}

function playFormulaAudio() {
  if (!formulaAudioDB || !currentRecordingKey) return;
  const tx = formulaAudioDB.transaction('recordings', 'readonly');
  const req = tx.objectStore('recordings').get(currentRecordingKey);
  req.onsuccess = e => {
    if (!e.target.result) return showToast('No recording found.');
    const url = URL.createObjectURL(e.target.result.blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    audio.play();
    document.getElementById('playAudioBtn').textContent = '⏸ Playing...';
    audio.onended = () => { document.getElementById('playAudioBtn').textContent = '▶ Play'; URL.revokeObjectURL(url); };
  };
}

function deleteFormulaAudio() {
  if (!formulaAudioDB || !currentRecordingKey) return;
  if (!confirm('Delete this recording?')) return;
  const tx = formulaAudioDB.transaction('recordings', 'readwrite');
  tx.objectStore('recordings').delete(currentRecordingKey);
  tx.oncomplete = () => {
    showToast('Recording deleted.');
    document.getElementById('playAudioBtn').disabled = true;
    document.getElementById('deleteAudioBtn').disabled = true;
  };
}

function startListenMode() {
  const panel = document.getElementById('audioRecorderPanel');
  if (panel.style.display === 'none' || !panel.style.display) {
    panel.style.display = 'block';
    if (!currentRecordingKey) {
      showToast('👆 Click any formula below to select it for recording.');
    }
  } else {
    panel.style.display = 'none';
  }
}

// ═══════════════════════════════════════════════════════════════
// PHASE 5 — Travel Mode (One-Handed Swipe Flashcards)
// ═══════════════════════════════════════════════════════════════
let travelTouchStartY = 0;

function openTravelMode() {
  const overlay = document.getElementById('travelModeOverlay');
  overlay.classList.add('active');
  renderTravelCard();
  
  // Attach swipe handlers
  const card = document.getElementById('travelCard');
  card.addEventListener('touchstart', e => { travelTouchStartY = e.touches[0].clientY; }, { passive: true });
  card.addEventListener('touchend', e => {
    const dy = travelTouchStartY - e.changedTouches[0].clientY;
    if (Math.abs(dy) > 50) {
      if (dy > 0) { nextFlashcard(); } else { prevFlashcard(); }
      renderTravelCard();
    }
  }, { passive: true });
}

function closeTravelMode() {
  document.getElementById('travelModeOverlay').classList.remove('active');
}

function renderTravelCard() {
  const cards = FLASHCARDS[flashcardSubj];
  if (!cards || !cards.length) return;
  const card = cards[flashcardIdx];
  const container = document.getElementById('travelCardContent');
  const counter = document.getElementById('travelCounter');
  if (!container || !card) return;

  if (flashcardFlipped) {
    container.innerHTML = `
      <div style="font-size:clamp(2rem,6vw,4rem); font-weight:800; color:var(--primary); font-family:serif; line-height:1.2;">${card.a}</div>
      <div style="font-size:0.85rem; color:var(--text-muted); margin-top:16px; letter-spacing:0.05em;">ANSWER</div>`;
  } else {
    container.innerHTML = `
      <div style="font-size:clamp(1.2rem,4vw,2rem); font-weight:700; color:var(--text); line-height:1.4;">${card.q}</div>
      <div style="font-size:0.85rem; color:var(--text-muted); margin-top:20px;">Tap to reveal answer</div>`;
  }
  if (counter) counter.textContent = `${flashcardIdx + 1} / ${cards.length}`;
}

// ── Mistakes & Tools ──
function renderMistakes() {
  const list = document.getElementById('mistakeList');
  if (!list) return;
  const mistakes = App.mistakes || [];
  if (!mistakes.length) {
    list.innerHTML = '<p style="color:var(--text-dim);text-align:center;padding:20px;">No mistakes logged.</p>';
    return;
  }
  list.innerHTML = mistakes.map((m, i) => `
    <div style="background:var(--surface2);border-radius:12px;padding:12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
      <div style="flex:1;">
        <div style="font-size:0.6rem;color:var(--accent);font-weight:700;text-transform:uppercase;">${m.subj} • ${m.type}</div>
        <div style="font-weight:600;margin:4px 0;font-size:0.9rem;">${m.topic}</div>
        ${m.note ? `<div style="font-size:0.75rem;color:var(--text-dim);">${m.note}</div>` : ''}
      </div>
      <button onclick="deleteMistake(${i})" style="background:none;border:none;color:var(--red);font-size:1rem;cursor:pointer;flex-shrink:0;">🗑️</button>
    </div>`).join('');
}

async function saveMistake() {
  const subj = document.getElementById('mSubject').value;
  const type = document.getElementById('mType').value;
  const topic = document.getElementById('mTopic').value.trim();
  const note = document.getElementById('mNote').value.trim();
  if (!topic) return showToast('Enter a topic!');
  
  const mistakes = [...(App.mistakes || [])];
  mistakes.unshift({ subj, type, topic, note, id: Date.now() });
  await _db.collection('users').doc(App.user.uid).collection('data').doc('mistakes').set({ payload: mistakes });
  document.getElementById('mTopic').value = '';
  document.getElementById('mNote').value = '';
  showToast('Mistake logged!');
  closeMistakeForm();
}

async function deleteMistake(idx) {
  if (!confirm('Delete this mistake?')) return;
  const mistakes = [...(App.mistakes || [])];
  mistakes.splice(idx, 1);
  await _db.collection('users').doc(App.user.uid).collection('data').doc('mistakes').set({ payload: mistakes });
  showToast('Deleted.');
}

function showFormulas(subj) {
  const list = document.getElementById('formulaList');
  const data = {
    Physics: [
      {n:'F=ma', eq:'Newton\'s 2nd Law'},{n:'v=u+at', eq:'Kinematics 1'},{n:'v²=u²+2as', eq:'Kinematics 3'},
      {n:'KE=½mv²', eq:'Kinetic Energy'},{n:'p=mv', eq:'Linear Momentum'},{n:'F=kq₁q₂/r²', eq:'Coulomb\'s Law'},
      {n:'V=IR', eq:'Ohm\'s Law'},{n:'P=VI=I²R', eq:'Power'},{n:'E=hf', eq:'Photon Energy'},
      {n:'n₁sinθ₁=n₂sinθ₂', eq:'Snell\'s Law'},{n:'T=2π√(l/g)', eq:'Simple Pendulum'},{n:'PV=nRT', eq:'Ideal Gas'}
    ],
    Chemistry: [
      {n:'n=m/M', eq:'Mole Concept'},{n:'PV=nRT', eq:'Ideal Gas Law'},{n:'pH=-log[H⁺]', eq:'pH Scale'},
      {n:'ΔG=ΔH-TΔS', eq:'Gibbs Energy'},{n:'E=E°-RT/nF·lnQ', eq:'Nernst Eqn'},{n:'λ=h/mv', eq:'de Broglie'},
      {n:'t₁/₂=0.693/k', eq:'Half-Life'},{n:'Ka×Kb=Kw', eq:'Acid-Base'},{n:'Moles=N/Nₐ', eq:'Avogadro'},
      {n:'q=mcΔT', eq:'Calorimetry'},{n:'ΔU=q+w', eq:'1st Law Thermo'},{n:'Kp=Kc(RT)^Δn', eq:'Kp vs Kc'}
    ],
    Maths: [
      {n:'sin²x+cos²x=1', eq:'Pythagorean ID'},{n:'∫eˣ dx=eˣ+C', eq:'Integration'},{n:'d/dx(sinx)=cosx', eq:'Derivative'},
      {n:'x=(-b±√D)/2a', eq:'Quadratic Formula'},{n:'Sₙ=n/2(2a+(n-1)d)', eq:'AP Sum'},{n:'Sₙ=a(rⁿ-1)/(r-1)', eq:'GP Sum'},
      {n:'log(mn)=logm+logn', eq:'Log Product'},{n:'tan(A+B)=(tanA+tanB)/(1-tanAtanB)', eq:'Tan Addition'},
      {n:'C(n,r)=n!/(r!(n-r)!)', eq:'Combinations'},{n:'A·B=|A||B|cosθ', eq:'Dot Product'},
      {n:'Area=½|x₁(y₂-y₃)+...|', eq:'Triangle Area'},{n:'lim(sinx/x)=1 as x→0', eq:'Standard Limit'}
    ]
  };
  // Highlight active button
  ['Physics','Chemistry','Maths'].forEach(s => {
    const btn = document.getElementById('ff-' + s.substring(0,3).toLowerCase());
    if (btn) btn.style.background = s === subj ? 'var(--primary)' : 'var(--surface2)';
  });
  list.innerHTML = (data[subj] || []).map((f, i) => {
    const key = `${subj}_${i}`;
    return `
    <div onclick="selectFormulaForRecording('${key}', '${f.n} — ${f.eq.replace(/'/g, '')}')" style="background:var(--surface2);border-radius:12px;padding:16px;text-align:center;cursor:pointer;transition:all 0.2s;border:1px solid transparent;" onmouseover="this.style.borderColor='var(--primary)'" onmouseout="this.style.borderColor='transparent'" title="Click to record audio for this formula">
      <div style="font-family:serif;font-size:1.1rem;font-weight:700;color:var(--primary);margin-bottom:6px;">${f.n}</div>
      <div style="font-size:0.7rem;color:var(--text-dim);">${f.eq}</div>
      <div style="font-size:0.55rem;color:var(--text-muted);margin-top:6px;opacity:0.6;">🎙️ tap to record</div>
    </div>`;
  }).join('');
}

// ── Verification & Stats ──
function renderDashboard() {
  renderCountdown();
  renderPerformanceScore();
  renderSubjects();
  renderHeatmap();
}

function renderCountdown() {
  const today = new Date(); today.setHours(0,0,0,0);
  const calc = (dateStr, elId) => {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!dateStr) { el.textContent = '--'; return; }
    const diff = Math.ceil((new Date(dateStr) - today) / 86400000);
    el.textContent = diff > 0 ? diff : 'Done';
  };
  const dates = App.examDates || {};
  calc(dates.mains, 'mainDays');
  calc(dates.adv, 'advDays');
  if (dates.mains) {
    const el = document.getElementById('mainDateDisp');
    if (el) {
      el.textContent = `Mains: ${new Date(dates.mains).toLocaleDateString()}`;
      el.style.display = 'block';
    }
  }
}

function openExamModal() {
  // Pre-populate existing dates
  const dates = App.examDates || {};
  if (dates.mains) document.getElementById('mainDate').value = dates.mains;
  if (dates.adv) document.getElementById('advDate').value = dates.adv;
  document.getElementById('examModal').classList.add('active');
}

function closeExamModal() {
  document.getElementById('examModal').classList.remove('active');
}

async function saveExamDates() {
  const mains = document.getElementById('mainDate').value;
  const adv = document.getElementById('advDate').value;
  if (!mains && !adv) return showToast('Please set at least one date.');
  
  if (!App.user) return;
  await _db.collection('users').doc(App.user.uid).collection('settings').doc('examdates').set({ mains, adv });
  App.examDates = { mains, adv };
  closeExamModal();
  renderCountdown();
  showToast('📅 Exam dates saved!');
}

function renderPerformanceScore() {
  const now = new Date();
  let totalDue = 0, doneCount = 0;
  
  const allDoneKeys = new Set();
  Object.values(App.dailyData).forEach(day => {
    if (day.done) Object.keys(day.done).forEach(k => allDoneKeys.add(k));
  });

  App.entries.forEach(e => {
    e.revisions.forEach(r => {
      if (new Date(r.datetime) <= now) {
        totalDue++;
        if (allDoneKeys.has(`${e.id}_${r.label}`)) doneCount++;
      }
    });
  });

  const score = totalDue ? Math.round((doneCount / totalDue) * 100) : 0;
  const scoreEl = document.getElementById('perfScore');
  const barEl = document.getElementById('perfBar');
  const doneEl = document.getElementById('perfDone');
  const pendingEl = document.getElementById('perfPending');

  if (scoreEl) scoreEl.innerHTML = `${score}<span>%</span>`;
  if (barEl) barEl.style.width = `${score}%`;
  if (doneEl) doneEl.textContent = doneCount;
  if (pendingEl) pendingEl.textContent = Math.max(0, totalDue - doneCount);
}

function renderSubjects() {
  const counts = { Physics: 0, Chemistry: 0, Maths: 0 };
  App.entries.forEach(e => {
    let subjects = e.subject;
    if (!subjects) subjects = ['General'];
    else if (!Array.isArray(subjects)) subjects = [subjects];
    
    subjects.forEach(s => {
      if (counts[s] !== undefined) counts[s]++;
    });
  });
  const row = document.getElementById('subjRow');
  row.innerHTML = Object.entries(counts).map(([name, count]) => `
    <div onclick="showSubjectDetail('${name}')" style="background:var(--surface2); padding:15px; border-radius:12px; text-align:center; cursor:pointer; transition:all 0.2s var(--smooth); border:1px solid var(--border);" onmouseover="this.style.borderColor='var(--primary)'; this.style.transform='translateY(-2px)'" onmouseout="this.style.borderColor='var(--border)'; this.style.transform='translateY(0)'">
      <div style="font-size:0.7rem; color:var(--text-dim); text-transform:uppercase;">${name}</div>
      <div style="font-size:1.4rem; font-weight:700;">${count}</div>
    </div>
  `).join('');
}

function showSubjectDetail(subject) {
  const modal = document.getElementById('subjectModal');
  const title = document.getElementById('modalSubjectTitle');
  const list = document.getElementById('subjectTopicList');
  if (!modal || !list) return;

  title.textContent = `${subject} Mastery`;
  const filtered = App.entries.filter(e => {
    const subjects = Array.isArray(e.subject) ? e.subject : [e.subject];
    return subjects.includes(subject);
  });

  if (!filtered.length) {
    list.innerHTML = `<p style="text-align:center; color:var(--text-dim); padding:40px;">No ${subject} topics logged yet.</p>`;
  } else {
    list.innerHTML = filtered.map(e => {
      const doneCount = e.revisions.filter(r => {
        const key = `${e.id}_${r.label}`;
        return Object.values(App.dailyData).some(day => day.done && day.done[key]);
      }).length;
      const pct = Math.round((doneCount / e.revisions.length) * 100);
      
      return `
        <div style="background:var(--surface2); border-radius:12px; padding:16px; margin-bottom:12px; border:1px solid var(--border);">
          <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div style="min-width:0; flex:1;">
              <div class="topic-title-safe" style="font-weight:700; color:var(--text);">${e.topic}</div>
              <div style="font-size:0.75rem; color:var(--text-dim); margin-top:4px;">${new Date(e.dateStr).toLocaleDateString()}</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:1rem; font-weight:800; color:var(--primary);">${pct}%</div>
              <div style="font-size:0.65rem; color:var(--text-muted);">Mastery</div>
            </div>
          </div>
          <div style="height:4px; background:var(--border); border-radius:2px; margin-top:12px; overflow:hidden;">
            <div style="width:${pct}%; height:100%; background:var(--primary); transition:width 0.4s var(--smooth);"></div>
          </div>
        </div>
      `;
    }).join('');
  }
  modal.classList.add('active');
}

function renderHeatmap() {
  const grid = document.getElementById('heatmapGrid');
  const monthContainer = document.getElementById('heatmapMonths');
  const legend = document.getElementById('heatmapLegend');
  if (!grid) return;

  const activity = {}; 
  App.entries.forEach(e => {
    if (!e.dateStr) return;
    if (!activity[e.dateStr]) activity[e.dateStr] = { topics: 0, hours: 0, masterySum: 0, masteryCount: 0 };
    activity[e.dateStr].topics++;
    const revisions = e.revisions || [];
    const doneCount = revisions.filter(r => {
      const key = `${e.id}_${r.label}`;
      return Object.values(App.dailyData).some(day => day.done && day.done[key]);
    }).length;
    const pct = Math.round((doneCount / (revisions.length || 1)) * 100);
    activity[e.dateStr].masterySum += pct;
    activity[e.dateStr].masteryCount++;
  });
  Object.values(App.studyTime).forEach(st => {
    if (!st.date) return;
    if (!activity[st.date]) activity[st.date] = { topics: 0, hours: 0, masterySum: 0, masteryCount: 0 };
    activity[st.date].hours += (st.hours || 0);
  });

  const totalDays = 182;
  const today = new Date();
  let start = new Date(today);
  start.setDate(start.getDate() - (totalDays - 1));

  let weeks = [], week = [];
  let monthLabels = [];
  let currentMonth = -1;

  for (let i = 0; i < totalDays; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const ds = toLocalDate(d);
    
    if (d.getMonth() !== currentMonth) {
      if (week.length === 0 || week.length === 1) { // Only add label at start of column
        monthLabels.push(d.toLocaleDateString('en-IN', { month: 'short' }));
        currentMonth = d.getMonth();
      }
    }

    week.push({ ds, data: activity[ds] });
    if (week.length === 7) { 
      weeks.push(week); 
      week = []; 
    }
  }
  if (week.length) weeks.push(week);

  if (monthContainer) {
    monthContainer.innerHTML = monthLabels.map(m => `<span class="heatmap-month">${m}</span>`).join('');
  }

  grid.innerHTML = weeks.map(wk =>
    `<div style="display:flex;flex-direction:column;gap:3px;">${wk.map(day => {
      if (!day.data) return `<div title="${day.ds}: No activity" class="heatmap-cell" style="background:var(--border);"></div>`;
      const d = day.data;
      const avgMastery = d.masteryCount ? Math.round(d.masterySum / d.masteryCount) : 0;
      
      // Fix: Improved activity color weighting logic
      let cellColor = 'var(--border)'; // Default empty
      if (d.topics > 0) {
        const weight = d.topics === 1 ? 0.3 : d.topics <= 3 ? 0.5 : d.topics <= 5 ? 0.8 : 1;
        cellColor = `hsla(var(--p-h), 80%, 60%, ${weight})`;
      }
      
      const borderColor = d.hours > 0 ? `border: 1.5px solid rgba(20,184,166,${Math.min(d.hours / 4, 1)})` : 'border: 1px solid transparent';
      const glowEffect = avgMastery > 70 ? `; box-shadow: 0 0 10px hsla(270,80%,60%,0.5); background-color: #a855f7 !important` : `background-color: ${cellColor}`;
      
      const tip = `${day.ds} | Topics: ${d.topics} | Hours: ${d.hours.toFixed(1)} | Mastery: ${avgMastery}%`;
      return `<div title="${tip}" class="heatmap-cell" style="${borderColor}; ${glowEffect}"></div>`;
    }).join('')}</div>`).join('');

  if (legend) {
    legend.innerHTML = `
      <div class="legend-item"><div class="legend-dot" style="background:hsla(var(--p-h),80%,60%,0.7)"></div> Topics Studied</div>
      <div class="legend-item"><div class="legend-dot" style="border:2px solid var(--teal)"></div> Study Hours Logged</div>
      <div class="legend-item"><div class="legend-dot" style="box-shadow:0 0 8px #a855f7; background:#a855f7;"></div> High Mastery (>70%)</div>
    `;
  }
}

// ── Native Calendar ──
let calDate = new Date();

function calPrevMonth() { calDate.setMonth(calDate.getMonth() - 1); renderNativeCalendar(); }
function calNextMonth() { calDate.setMonth(calDate.getMonth() + 1); renderNativeCalendar(); }
function calToday() { calDate = new Date(); renderNativeCalendar(); }

function renderNativeCalendar() {
  const grid = document.getElementById('nativeCalGrid');
  const label = document.getElementById('calMonthLabel');
  if (!grid) return;

  const year = calDate.getFullYear();
  const month = calDate.getMonth();
  const todayStr_ = toLocalDate(new Date());
  label.textContent = calDate.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  // Build event map from entries
  const eventMap = {};
  App.entries.forEach(e => {
    (e.revisions || []).forEach(r => {
      const dt = r.datetime ? new Date(r.datetime) : null;
      if (!dt || isNaN(dt)) return;
      const ds = toLocalDate(dt);
      if (!eventMap[ds]) eventMap[ds] = [];
      eventMap[ds].push({ topic: e.topic, subject: e.subject, label: r.label, id: e.id, datetime: dt });
    });
  });

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevDays = new Date(year, month, 0).getDate();

  let cells = [];
  // Prev month
  for (let i = firstDay - 1; i >= 0; i--)
    cells.push({ day: prevDays - i, cur: false, ds: null });
  // Current month
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${p(month+1)}-${p(d)}`;
    cells.push({ day: d, cur: true, ds, isToday: ds === todayStr_, evs: eventMap[ds] || [] });
  }
  // Next month
  let fill = cells.length % 7 === 0 ? 0 : 7 - (cells.length % 7);
  for (let d = 1; d <= fill; d++)
    cells.push({ day: d, cur: false, ds: null });

  const subjectColor = s => s === 'Physics' ? '#6366f1' : s === 'Chemistry' ? '#f59e0b' : s === 'Maths' ? '#10b981' : '#a855f7';

  grid.innerHTML = cells.map(c => {
    if (!c.cur) return `<div style="min-height:90px;background:var(--border);opacity:0.2;border-radius:10px;padding:8px;"><span style="font-size:0.75rem;color:var(--text-dim);">${c.day}</span></div>`;
    const evs = c.evs || [];
    const dots = evs.slice(0, 3).map(ev => `<div style="display:flex;align-items:center;gap:4px;margin-top:2px;"><div style="width:6px;height:6px;border-radius:50%;background:${subjectColor(ev.subject)};flex-shrink:0;"></div><div class="topic-title-safe" style="font-size:0.55rem;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:70px;">${ev.topic}</div></div>`).join('');
    const more = evs.length > 3 ? `<div style="font-size:0.5rem;color:var(--text-muted);margin-top:2px;">+${evs.length-3} more</div>` : '';
    const border = c.isToday ? '2px solid var(--primary)' : '1px solid var(--border)';
    const bg = c.isToday ? 'var(--primary-pale)' : 'var(--surface)';
    return `<div onclick="openCalDay('${c.ds}')" style="min-height:90px;background:${bg};border:${border};border-radius:10px;padding:8px;cursor:pointer;transition:all 0.2s;" onmouseenter="this.style.borderColor='var(--primary)'" onmouseleave="this.style.borderColor='${c.isToday ? 'var(--primary)' : 'var(--border)'}'">
      <span style="font-size:0.8rem;font-weight:${c.isToday ? 800 : 600};color:${c.isToday ? 'var(--primary)' : 'var(--text)'}">${c.day}</span>
      ${dots}${more}
    </div>`;
  }).join('');
}

function openCalDay(ds) {
  const panel = document.getElementById('calDayPanel');
  const title = document.getElementById('calDayTitle');
  const list = document.getElementById('calDayEvents');
  panel.style.display = 'block';
  const d = new Date(ds + 'T00:00:00');
  title.textContent = d.toLocaleDateString('en-IN', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const eventMap = {};
  App.entries.forEach(e => {
    (e.revisions || []).forEach(r => {
      const dt = r.datetime ? new Date(r.datetime) : null;
      if (!dt || isNaN(dt)) return;
      if (toLocalDate(dt) === ds) {
        if (!eventMap[e.id]) eventMap[e.id] = { ...e, times: [] };
        eventMap[e.id].times.push({ label: r.label, time: dt.toLocaleTimeString('en-IN', {hour:'2-digit', minute:'2-digit'}) });
      }
    });
  });
  const entries_ = Object.values(eventMap);
  if (!entries_.length) {
    list.innerHTML = '<p style="text-align:center;color:var(--text-dim);padding:24px;">☕ No revisions scheduled.</p>';
    return;
  }
  const subjectColor = s => s === 'Physics' ? '#6366f1' : s === 'Chemistry' ? '#f59e0b' : s === 'Maths' ? '#10b981' : '#a855f7';
  list.innerHTML = entries_.map(e => `
    <div style="display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--border);">
      <div style="width:4px;min-height:40px;border-radius:4px;background:${subjectColor(e.subject)};flex-shrink:0;"></div>
      <div style="flex:1; min-width:0;">
        <div class="topic-title-safe" style="font-weight:700;font-size:0.95rem;">${e.topic}</div>
        <div style="font-size:0.7rem;color:var(--text-dim);margin-top:2px;">${e.times.map(t => `${t.label} • ${t.time}`).join(' | ')}</div>
      </div>
      <button onclick="deleteEntry('${e.id}')" style="background:none;border:none;color:var(--red);font-size:1rem;cursor:pointer;">🗑️</button>
    </div>`).join('');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Search / Log Utilities ──
function filterLog() {
  const q = document.getElementById('searchInput')?.value?.trim() || '';
  App.searchQuery = q;
  document.getElementById('searchClear').style.display = q ? 'block' : 'none';
  renderLog();
}

function clearSearch() {
  document.getElementById('searchInput').value = '';
  App.searchQuery = '';
  document.getElementById('searchClear').style.display = 'none';
  renderLog();
}

function updateTodayBadge() {
  const count = getTodayItems().length;
  const badge = document.getElementById('todayBadge');
  if (badge) badge.textContent = count > 0 ? count : '';
}

async function bulkNotifyToday() {
  const pending = getTodayItems(true); // pendingOnly = true → skip completed
  if (!pending.length) { showToast('🎉 All done for today!'); return; }
  if (Notification.permission === 'denied') { showToast('Notifications are blocked in browser settings.'); return; }
  if (Notification.permission !== 'granted') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') { showToast('Please allow notifications to use this feature.'); return; }
  }
  pending.forEach((item, idx) => {
    setTimeout(() => {
      new Notification('Revision Due: ' + item.topic, {
        body: `Time for your ${item.label} revision.`,
        icon: 'https://cdn-icons-png.flaticon.com/512/5968/5968313.png',
        tag: item.key
      });
    }, idx * 150);
  });
  showToast(`🔔 Sent ${pending.length} pending reminder${pending.length > 1 ? 's' : ''}!`);
}

async function checkApproval() {
  if (!App.user) return;
  showToast('Checking status...');
  try {
    const doc = await _db.collection('users').doc(App.user.uid).get();
    if (doc.exists && doc.data().status === 'approved') {
      showToast('✅ Account Approved!');
      initApp();
    } else {
      showToast('⌛ Still pending. Please wait for admin approval.');
    }
  } catch(e) { 
    console.error(e);
    showToast('Error checking status. Please try again.');
  }
}

// ── Init ──
initBrandingSync();

// ── Utility Exports ──
window.doLogin = doLogin;
window.doRegister = doRegister;
window.doLogout = doLogout;
window.showAuthTab = showAuthTab;
window.checkApproval = checkApproval;
window.switchTab = switchTab;
window.selectSubjectChip = selectSubjectChip;
window.addEntry = addEntry;
window.savePendingEntry = savePendingEntry;
window.toggleTheme = toggleTheme;
window.openExamModal = openExamModal;
window.closeExamModal = closeExamModal;
window.saveExamDates = saveExamDates;
window.deleteEntry = deleteEntry;
window.rateRevision = rateRevision;
window.saveMistake = saveMistake;
window.deleteMistake = deleteMistake;
window.showFormulas = showFormulas;
window.openMistakeForm = () => document.getElementById('mistakeModal').classList.add('active');
window.closeMistakeForm = () => document.getElementById('mistakeModal').classList.remove('active');
window.p(0); // init padding helper
window.setPomoMode = setPomoMode;
window.startPomo = startPomo;
window.addPomoTime = addPomoTime;
window.toggleTimerFullScreen = toggleTimerFullScreen;
window.logStudyTime = logStudyTime;
window.logQuestionsAttempted = logQuestionsAttempted;
window.saveMockTest = saveMockTest;
window.showFlashcard = showFlashcard;
window.flipFlashcard = flipFlashcard;
window.nextFlashcard = nextFlashcard;
window.prevFlashcard = prevFlashcard;
window.filterLog = filterLog;
window.clearSearch = clearSearch;
window.bulkNotifyToday = bulkNotifyToday;
window.calPrevMonth = calPrevMonth;
window.calNextMonth = calNextMonth;
window.calToday = calToday;
window.openCalDay = openCalDay;
// v8.0 exports
window.startListenMode = startListenMode;
window.toggleRecording = toggleRecording;
window.playFormulaAudio = playFormulaAudio;
window.deleteFormulaAudio = deleteFormulaAudio;
window.openTravelMode = openTravelMode;
window.closeTravelMode = closeTravelMode;
window.renderTravelCard = renderTravelCard;
window.selectFormulaForRecording = selectFormulaForRecording;
window.downloadICS = downloadICS;

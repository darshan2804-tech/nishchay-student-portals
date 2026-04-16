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
  _unsubs: []
};

// ── Helpers ──
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
    showScreen('pendingScreen');
  } catch(e) { showToast(e.message); }
}

function doLogout() {
  _auth.signOut();
  window.location.reload();
}

async function loadBranding() {
  try {
    const doc = await _db.collection('settings').doc('branding').get();
    if (doc.exists) {
      const data = doc.data();
      if (data.logoUrl) {
        document.getElementById('loginLogo').src = data.logoUrl;
        document.getElementById('sidebarLogo').src = data.logoUrl;
      }
    }
  } catch(e) { console.error('Logo load failed', e); }
}

_auth.onAuthStateChanged(async user => {
  loadBranding();
  if (!user) return showScreen('authScreen');
  App.user = user;
  const doc = await _db.collection('users').doc(user.uid).get();
  if (doc.exists && doc.data().status === 'approved') {
    initApp();
  } else if (ADMIN_EMAILS.includes(user.email)) {
    // Auto-approve admin
    await _db.collection('users').doc(user.uid).set({ status: 'approved' }, { merge: true });
    initApp();
  } else {
    showScreen('pendingScreen');
  }
});

// ── App Core ──
async function initApp() {
  showScreen('appScreen');
  updateClock(); setInterval(updateClock, 1000);
  const name = App.user.displayName || App.user.email;
  document.getElementById('userAvatar').textContent = name[0].toUpperCase();
  document.getElementById('menuName').textContent = name;
  document.getElementById('menuEmail').textContent = App.user.email;
  
  setupListeners();
  loadSettings();
  syncInputTime();
}

function setupListeners() {
  // Real-time entries
  const unsub = _db.collection('users').doc(App.user.uid).collection('entries')
    .orderBy('createdAt', 'desc')
    .onSnapshot(snap => {
      App.entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      refreshActivePage();
      updateTodayBadge();
    });
  App._unsubs.push(unsub);

  // Today's progress
  const ts = todayStr();
  const unsubToday = _db.collection('users').doc(App.user.uid).collection('daily').doc(ts)
    .onSnapshot(snap => {
      App.dailyData[ts] = snap.exists ? snap.data() : { done: {}, ratings: {} };
      if (document.getElementById('page-today').classList.contains('active')) renderToday();
    });
  App._unsubs.push(unsubToday);
}

async function loadSettings() {
  try {
    const doc = await _db.collection('users').doc(App.user.uid).collection('settings').doc('examdates').get();
    if (doc.exists) App.examDates = doc.data();
    renderCountdown();
  } catch(e) {}
}

// ── UI Interactivity ──
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
  
  if (name === 'calendar') {
    const iframe = document.getElementById('calendarIframe');
    if (iframe && !iframe.dataset.loaded) {
      const email = sessionStorage.getItem('sh_email');
      const passArr = sessionStorage.getItem('sh_pass');
      if (email && passArr) {
        const pass = atob(passArr);
        const baseUrl = 'https://study-calendar-standalone.vercel.app?embedded=true';
        iframe.src = `${baseUrl}#email=${encodeURIComponent(email)}&pass=${encodeURIComponent(pass)}`;
      } else {
        // No SSO credentials — just load without auto-login
        iframe.src = 'https://study-calendar-standalone.vercel.app?embedded=true';
      }
      iframe.dataset.loaded = 'true';
    }
  }
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
  { label: '12 hrs', mins: 720, type: 'short' },
  { label: 'Day 1', mins: 1440, type: 'long' },
  { label: 'Day 2', mins: 2880, type: 'long' },
  { label: 'Day 4', mins: 5760, type: 'long' },
  { label: 'Day 7', mins: 10080, type: 'long' },
  { label: 'Day 15', mins: 21600, type: 'long' },
  { label: 'Day 30', mins: 43200, type: 'long' }
];

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

  App.pendingEntry = { id: Date.now(), topic, dateStr, timeStr, revisions };
  
  showResult(App.pendingEntry);
}

function showResult(entry) {
  const rc = document.getElementById('resultCard');
  const title = document.getElementById('resultTopic');
  const list = document.getElementById('intervalsList');
  rc.style.display = 'block';
  title.textContent = entry.topic;
  list.innerHTML = entry.revisions.map(r => `
    <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border); font-size:0.8rem;">
      <span style="font-weight:600; color:var(--primary);">${r.label}</span>
      <span style="color:var(--text-muted);">${new Date(r.datetime).toLocaleDateString()} ${new Date(r.datetime).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
    </div>
  `).join('');
  
  const saveBtn = document.getElementById('addToCalIcsBtn');
  if (saveBtn) saveBtn.textContent = 'Add to my calendar';
  
  rc.scrollIntoView({ behavior: 'smooth' });
}

async function savePendingEntry() {
  if (!App.pendingEntry) return;
  const btn = document.getElementById('addToCalIcsBtn');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    await _db.collection('users').doc(App.user.uid).collection('entries').doc(String(App.pendingEntry.id))
      .set({ ...App.pendingEntry, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    showToast('Topic saved to cloud!');
    document.getElementById('resultCard').style.display = 'none';
    document.getElementById('topicInput').value = '';
    App.pendingEntry = null;
  } catch(e) { showToast(e.message); btn.disabled = false; btn.textContent = 'Save to Cloud Firestore'; }
}

// ── UI Rendering ──

function renderToday() {
  const ts = todayStr();
  const daily = App.dailyData[ts] || { done: {}, ratings: {} };
  const items = getTodayItems();
  const c = document.getElementById('todayContent');
  if (!items.length) {
    c.innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-dim);">No revisions scheduled for today.</div>';
    return;
  }

  c.innerHTML = `
    <div class="card">
      ${items.map(item => {
        const isDone = daily.done[item.key];
        const rating = daily.ratings[item.key] || '';
        return `
          <div style="display:flex; align-items:center; gap:12px; padding:15px 0; border-bottom:1px solid var(--border); ${isDone ? 'opacity:0.5' : ''}">
            <div style="flex:1;">
              <div style="font-weight:600; font-size:0.9rem;">${item.topic}</div>
              <div style="font-size:0.7rem; color:var(--text-dim);">${item.label}</div>
            </div>
            ${!isDone ? `
              <div style="display:flex; gap:8px;">
                <button onclick="rateRevision('${item.key}', 'easy')" style="background:rgba(16,185,129,0.1); color:var(--green); border:none; padding:6px 12px; border-radius:8px; font-size:0.75rem; font-weight:700; cursor:pointer;">Easy</button>
                <button onclick="rateRevision('${item.key}', 'hard')" style="background:rgba(239,68,68,0.1); color:var(--red); border:none; padding:6px 12px; border-radius:8px; font-size:0.75rem; font-weight:700; cursor:pointer;">Hard</button>
              </div>
            ` : `<span style="color:var(--green); font-size:0.8rem; font-weight:700;">✓ Done</span>`}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function getTodayItems() {
  const ts = todayStr();
  const items = [];
  App.entries.forEach(e => {
    e.revisions.forEach(r => {
      if (toLocalDate(new Date(r.datetime)) === ts) {
        items.push({ topic: e.topic, label: r.label, key: `${e.id}_${r.label}`, id: e.id });
      }
    });
  });
  return items;
}

async function rateRevision(key, rating) {
  const ts = todayStr();
  const ref = _db.collection('users').doc(App.user.uid).collection('daily').doc(ts);
  await ref.set({
    done: { [key]: true },
    ratings: { [key]: rating }
  }, { merge: true });
  showToast(`Marked as ${rating}!`);
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
        <div style="font-weight:600;">${e.topic}</div>
        <div style="font-size:0.75rem; color:var(--text-dim);">${new Date(e.dateStr).toLocaleDateString()}</div>
      </div>
      <button onclick="deleteEntry('${e.id}')" style="background:none; border:none; font-size:1.1rem; cursor:pointer; opacity:0.5;">✕</button>
    </div>
  `).join('');
}

async function deleteEntry(id) {
  if (!confirm('Are you sure you want to delete this topic?')) return;
  await _db.collection('users').doc(App.user.uid).collection('entries').doc(id).delete();
  showToast('Topic deleted.');
}

function initTools() {
  renderMistakes();
  showFormulas('Physics');
}

// ── Mistakes & Tools ──
function renderMistakes() {
  const list = document.getElementById('mistakeList');
  if (!list) return;
  // Load from firestore
  _db.collection('users').doc(App.user.uid).collection('data').doc('mistakes').get().then(doc => {
    const mistakes = doc.exists ? doc.data().payload : [];
    if (!mistakes.length) {
      list.innerHTML = '<p style="color:var(--text-dim); text-align:center; padding:20px;">No mistakes logged.</p>';
      return;
    }
    list.innerHTML = mistakes.map(m => `
      <div class="card" style="padding:12px; margin-bottom:8px;">
        <div style="font-size:0.6rem; color:var(--accent); font-weight:700;">${m.subj} • ${m.type}</div>
        <div style="font-weight:600; margin:4px 0;">${m.topic}</div>
        <div style="font-size:0.75rem; color:var(--text-dim);">${m.note}</div>
      </div>
    `).join('');
  });
}

async function saveMistake() {
  const subj = document.getElementById('mSubject').value;
  const type = document.getElementById('mType').value;
  const topic = document.getElementById('mTopic').value.trim();
  const note = document.getElementById('mNote').value.trim();
  if (!topic) return showToast('Enter a topic!');
  
  const doc = await _db.collection('users').doc(App.user.uid).collection('data').doc('mistakes').get();
  const mistakes = doc.exists ? doc.data().payload : [];
  mistakes.unshift({ subj, type, topic, note, id: Date.now() });
  
  await _db.collection('users').doc(App.user.uid).collection('data').doc('mistakes').set({ payload: mistakes });
  showToast('Mistake logged!');
  closeMistakeForm();
  renderMistakes();
}

function showFormulas(subj) {
  const list = document.getElementById('formulaList');
  // Simple formula data
  const data = {
    Physics: [{n:'F=ma', eq:'Newton\'s 2nd Law'}, {n:'v=u+at', eq:'Kinematics'}],
    Chemistry: [{n:'n=m/M', eq:'Mole Concept'}, {n:'PV=nRT', eq:'Ideal Gas'}],
    Maths: [{n:'sin²x+cos²x=1', eq:'Identity'}, {n:'∫eˣ dx = eˣ', eq:'Integral'}]
  };
  list.innerHTML = (data[subj] || []).map(f => `
    <div class="card" style="text-align:center;">
      <div style="font-family:serif; font-size:1.2rem; font-weight:700; color:var(--primary);">${f.n}</div>
      <div style="font-size:0.7rem; color:var(--text-dim);">${f.eq}</div>
    </div>
  `).join('');
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
    if (!el || !dateStr) return;
    const diff = Math.ceil((new Date(dateStr) - today) / 86400000);
    el.textContent = diff > 0 ? diff : 'Done';
  };
  calc(App.examDates.mains, 'mainDays');
  calc(App.examDates.adv, 'advDays');
  if (App.examDates.mains) document.getElementById('mainDateDisp').textContent = `Mains: ${new Date(App.examDates.mains).toLocaleDateString()}`;
}

function renderPerformanceScore() {
  const today = new Date(); today.setHours(0,0,0,0);
  let totalDue = 0, doneCount = 0;
  
  // Actually, calculation is better based on entries
  const allDoneKeys = new Set();
  Object.values(App.dailyData).forEach(day => Object.keys(day.done || {}).forEach(k => allDoneKeys.add(k)));

  App.entries.forEach(e => {
    e.revisions.forEach(r => {
      if (new Date(r.datetime) <= today) {
        totalDue++;
        if (allDoneKeys.has(`${e.id}_${r.label}`)) doneCount++;
      }
    });
  });

  const score = totalDue ? Math.round((doneCount/totalDue)*100) : 0;
  document.getElementById('perfScore').innerHTML = `${score}<span>%</span>`;
  document.getElementById('perfBar').style.width = `${score}%`;
  document.getElementById('perfDone').textContent = doneCount;
  document.getElementById('perfPending').textContent = totalDue - doneCount;
}

function renderSubjects() {
  const counts = { Physics: 0, Chemistry: 0, Maths: 0 };
  App.entries.forEach(e => {
    const t = e.topic.toLowerCase();
    if (t.includes('phy')) counts.Physics++;
    else if (t.includes('chem')) counts.Chemistry++;
    else if (t.includes('math')) counts.Maths++;
    else counts.Physics++; // default
  });
  const row = document.getElementById('subjRow');
  row.innerHTML = Object.entries(counts).map(([name, count]) => `
    <div style="background:var(--surface2); padding:15px; border-radius:12px; text-align:center;">
      <div style="font-size:0.7rem; color:var(--text-dim); text-transform:uppercase;">${name}</div>
      <div style="font-size:1.4rem; font-weight:700;">${count}</div>
    </div>
  `).join('');
}

function renderHeatmap() {
  const grid = document.getElementById('heatmapGrid');
  const activity = {};
  App.entries.forEach(e => activity[e.dateStr] = (activity[e.dateStr] || 0) + 1);
  
  let html = '';
  for (let i = 20; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const ds = toLocalDate(d);
    const level = activity[ds] ? Math.min(activity[ds], 4) : 0;
    html += `<div style="width:12px; height:12px; border-radius:2px; background:hsla(var(--p-h), 80%, 60%, ${level * 0.25}); flex-shrink:0;"></div>`;
  }
  grid.innerHTML = html;
}

// ── Utility Exports ──
window.doLogin = doLogin;
window.doRegister = doRegister;
window.doLogout = doLogout;
window.showAuthTab = showAuthTab;
window.checkApproval = checkApproval;
window.switchTab = switchTab;
window.addEntry = addEntry;
window.savePendingEntry = savePendingEntry;
window.toggleTheme = () => { document.body.classList.toggle('dark-mode'); };
window.openExamModal = () => document.getElementById('examModal').classList.add('active');
window.closeExamModal = () => document.getElementById('examModal').classList.remove('active');
window.saveExamDates = async () => {
  const mains = document.getElementById('mainDate').value;
  const adv = document.getElementById('advDate').value;
  await _db.collection('users').doc(App.user.uid).collection('settings').doc('examdates').set({ mains, adv });
  App.examDates = { mains, adv };
  window.closeExamModal(); renderCountdown();
};
window.deleteEntry = deleteEntry;
window.rateRevision = rateRevision;
window.saveMistake = saveMistake;
window.showFormulas = showFormulas;
window.openMistakeForm = () => document.getElementById('mistakeModal').classList.add('active');
window.closeMistakeForm = () => document.getElementById('mistakeModal').classList.remove('active');

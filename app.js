const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyBRw3GxukFyPEcjOY-0FIsXBk2p-7TQivM",
  authDomain:        "study-tracker-52de8.firebaseapp.com",
  projectId:         "study-tracker-52de8",
  storageBucket:     "study-tracker-52de8.firebasestorage.app",
  messagingSenderId: "183173939785",
  appId:             "1:183173939785:web:5fc5eee2f86b87c356b598"
};
const ADMIN_EMAILS = ["darshanderkar20@gmail.com","derkardarshan@gmail.com"];
const APP_NAME     = "Study Tracker";
const APP_TAGLINE  = "Spaced Repetition System";

// -- FIREBASE INIT --
firebase.initializeApp(FIREBASE_CONFIG);
const auth = firebase.auth();
const db   = firebase.firestore();

let currentUser = null;
let entries     = [];
let cancelFlag  = false;
let searchQuery = '';

const INTERVALS = [
  {label:'12 hrs', mins:720,   type:'short'},
  {label:'Day 1',  mins:1440,  type:'long'},
  {label:'Day 2',  mins:2880,  type:'long'},
  {label:'Day 4',  mins:5760,  type:'long'},
  {label:'Day 7',  mins:10080, type:'long'},
  {label:'Day 15', mins:21600, type:'long'},
  {label:'Day 30', mins:43200, type:'long'}
];

const isApple = /iphone|ipad|ipod|macintosh/i.test(navigator.userAgent);

// -- SHOW SCREEN --
// FIX: bottom-nav hidden on auth/pending, shown only on appScreen
function showScreen(id){
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  const nav = document.querySelector('.bottom-nav');
  if(nav) nav.style.display = (id === 'appScreen') ? 'flex' : 'none';
}

// -- AUTH STATE --
showScreen('authScreen');

auth.onAuthStateChanged(async user => {
  if(!user){ showScreen('authScreen'); return; }
  currentUser = user;
  // Always go to pending screen first, then checkApproval will load the app
  if(ADMIN_EMAILS.includes(user.email)){
    // Admins go straight in
    try {
      await db.collection('users').doc(user.uid).set({
        name: user.displayName || user.email.split('@')[0],
        email: user.email, status: 'approved',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }, {merge: true});
    } catch(e){ console.log('Admin doc update skipped'); }
    initApp(user);
  } else {
    try {
      const doc = await db.collection('users').doc(user.uid).get();
      if (!doc.exists) {
        // Admin removed the user doc
        await auth.signOut(); showScreen('authScreen');
        showAuthMsg('loginMsg','Account removed. Contact admin.','error');
        return;
      }
      const st = doc.data()?.status;
      if(st==='approved'){ initApp(user); }
      else if(st==='pending'){ showScreen('pendingScreen'); }
      else { 
        await auth.signOut(); showScreen('authScreen');
        showAuthMsg('loginMsg','Access denied by admin.','error');
      }
    } catch(e){ 
      await auth.signOut(); showScreen('authScreen'); 
      showAuthMsg('loginMsg','Permission denied.','error');
    }
  }
});

// -- INIT APP --
async function initApp(user){
  showScreen('appScreen');
  loadTheme();
  const name = user.displayName || user.email || 'U';
  document.getElementById('userAvatar').textContent = name[0].toUpperCase();
  document.getElementById('menuName').textContent   = name;
  document.getElementById('menuEmail').textContent  = user.email;
  loadEntries();
  syncInputTime(); updateClock();
  setInterval(updateClock, 1000);
  setInterval(syncInputTime, 60000);
  checkBackupReminder();
  if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
  updateNotifUI();
  try {
    const ed=await db.collection('users').doc(user.uid).collection('settings').doc('examdates').get();
    if(ed.exists) localStorage.setItem('ebbing_examdates_'+user.uid,JSON.stringify(ed.data()));
    const td=await db.collection('users').doc(user.uid).collection('settings').doc('studytarget').get();
    if(td.exists&&td.data().hours) localStorage.setItem('studyTargetHrs',td.data().hours);
  } catch(e){}
  
  setTimeout(() => migrateOfflineData(user.uid), 2000); // Trigger migration
}

async function migrateOfflineData(uid) {
  const flag = localStorage.getItem('migration_done_' + uid);
  if(flag) return;

  const batch = db.batch();
  const userRef = db.collection('users').doc(uid);
  let hasData = false;

  const mistakes = localStorage.getItem('jee_mistakes');
  if(mistakes) {
    batch.set(userRef.collection('data').doc('mistakes'), { payload: JSON.parse(mistakes) }, { merge: true });
    hasData = true;
  }

  const mocks = localStorage.getItem('jee_mocks');
  if(mocks) {
    batch.set(userRef.collection('data').doc('mocks'), { payload: JSON.parse(mocks) }, { merge: true });
    hasData = true;
  }

  if(hasData) {
    try {
      await batch.commit();
      localStorage.setItem('migration_done_' + uid, 'true');
      console.log('Migration to Firestore complete.');
    } catch(e) {
      console.error('Migration failed', e);
    }
  }
}

// -- FIRESTORE LOAD / SAVE (localStorage-first for instant load) --
async function loadEntries(){
  // 1. Load from localStorage instantly (zero wait)
  const cached = JSON.parse(localStorage.getItem('ebbing_entries_'+currentUser.uid)||'[]');
  if(cached.length){ entries = cached; updateTodayBadge(); }
  // 2. Background sync from Firestore (saves Firebase reads quota)
  const lastSync = parseInt(localStorage.getItem('ebbing_last_sync_'+currentUser.uid)||'0');
  const SYNC_INTERVAL = 5 * 60 * 1000; // sync every 5 min max
  if(!navigator.onLine){ showToast(cached.length?'Offline — showing cached data':'No internet'); return; }
  if(Date.now() - lastSync < SYNC_INTERVAL && cached.length){ return; } // skip if recently synced
  try {
    const snap = await db.collection('users').doc(currentUser.uid)
      .collection('entries').orderBy('createdAt','desc').get();
    entries = snap.docs.map(d => ({id:d.id, ...d.data()}));
    localStorage.setItem('ebbing_entries_'+currentUser.uid, JSON.stringify(entries));
    localStorage.setItem('ebbing_last_sync_'+currentUser.uid, Date.now());
    updateTodayBadge();
  } catch(e) {
    if(!cached.length) showToast('⚠️ Could not load data. Check connection.');
  }
}

async function saveEntry(entry){
  // Always write to localStorage first (instant, no quota)
  localStorage.setItem('ebbing_entries_'+currentUser.uid, JSON.stringify(entries));
  if(!navigator.onLine){ return; } // offline — localStorage already saved
  try {
    const ref = db.collection('users').doc(currentUser.uid)
      .collection('entries').doc(String(entry.id));
    await ref.set({...entry, createdAt: firebase.firestore.FieldValue.serverTimestamp()});
    localStorage.setItem('ebbing_last_sync_'+currentUser.uid, Date.now());
  } catch(e) {
    console.warn('Cloud sync failed, data saved locally:', e.message);
  }
}

async function deleteEntryFromDB(id){
  try {
    await db.collection('users').doc(currentUser.uid)
      .collection('entries').doc(String(id)).delete();
  } catch(e) {
    localStorage.setItem('ebbing_entries_'+currentUser.uid, JSON.stringify(entries));
  }
}

// -- AUTH FUNCTIONS --
function showAuthTab(tab){
  document.getElementById('loginForm').style.display    = tab==='login'    ? 'block' : 'none';
  document.getElementById('registerForm').style.display = tab==='register' ? 'block' : 'none';
  document.getElementById('adminForm').style.display    = tab==='admin'    ? 'block' : 'none';
  const lt = document.getElementById('loginTab');
  const rt = document.getElementById('registerTab');
  const at = document.getElementById('adminTab');
  // Reset all
  [lt,rt,at].forEach(b=>{ b.style.background='transparent'; b.style.color='#64748b'; });
  // Highlight active
  if(tab==='login')    { lt.style.background='#0ea5e9';   lt.style.color='#fff'; }
  if(tab==='register') { rt.style.background='#0ea5e9';   rt.style.color='#fff'; }
  if(tab==='admin')    { at.style.background='#d97706';   at.style.color='#fff'; }
}

function showAuthMsg(id, msg, type){
  const el = document.getElementById(id);
  el.textContent = msg;
  if(type==='error')   el.style.cssText='color:#dc2626;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:8px;text-align:center;font-size:0.75rem;font-weight:500;margin-top:10px;';
  else if(type==='success') el.style.cssText='color:#16a34a;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:8px;text-align:center;font-size:0.75rem;font-weight:500;margin-top:10px;';
  else if(type==='info')    el.style.cssText='color:#0284c7;background:#e0f2fe;border:1px solid #bae6fd;border-radius:8px;padding:8px;text-align:center;font-size:0.75rem;font-weight:500;margin-top:10px;';
}

async function forgotPassword(){
  const email = document.getElementById('loginEmail').value.trim();
  if(!email){ showAuthMsg('loginMsg','Please enter your email address first.','error'); return; }
  try {
    await auth.sendPasswordResetEmail(email);
    showAuthMsg('loginMsg','Reset email sent to '+email+'! Check your inbox and spam folder.','success');
  } catch(e) {
    showAuthMsg('loginMsg','Error sending reset email. Check your email address.','error');
  }
}

async function doLogin(){
  const email = document.getElementById('loginEmail').value.trim();
  const pass  = document.getElementById('loginPass').value;
  if(!email){ showAuthMsg('loginMsg','Please enter your email.','error'); return; }
  if(!pass){  showAuthMsg('loginMsg','Please enter your password.','error'); return; }
  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  btn.innerHTML = '<span style="display:inline-block;width:18px;height:18px;border:3px solid rgba(255,255,255,0.4);border-top:3px solid #fff;border-radius:50%;animation:spin 0.8s linear infinite;vertical-align:middle;margin-right:8px;"></span>Logging in...';
  showAuthMsg('loginMsg','Connecting...','info');
  try {
    await auth.signInWithEmailAndPassword(email, pass);
    showAuthMsg('loginMsg','Login successful! Loading...','success');
  } catch(e) {
    let msg = 'Login failed. Check email and password.';
    if(e.code==='auth/user-not-found')       msg = 'No account with this email. Try Request Access.';
    if(e.code==='auth/wrong-password')        msg = 'Wrong password. Try again.';
    if(e.code==='auth/invalid-credential')    msg = 'Wrong email or password. Try again.';
    if(e.code==='auth/too-many-requests')     msg = 'Too many attempts. Try again in a few minutes.';
    if(e.code==='auth/network-request-failed') msg = 'No internet connection. Check your network.';
    showAuthMsg('loginMsg', msg, 'error');
    btn.disabled = false;
    btn.innerHTML = 'Login to Study Tracker';
  }
}

async function doAdminLogin(){
  const email = document.getElementById('adminEmail').value.trim();
  const pass  = document.getElementById('adminPass').value;
  if(!email){ showAuthMsg('adminMsg','Please enter your email.','error'); return; }
  if(!pass){  showAuthMsg('adminMsg','Please enter your password.','error'); return; }
  if(!ADMIN_EMAILS.includes(email)){ showAuthMsg('adminMsg','This email is not registered as admin.','error'); return; }
  const btn = document.getElementById('adminLoginBtn');
  btn.disabled = true;
  btn.innerHTML = '<span style="display:inline-block;width:18px;height:18px;border:3px solid rgba(255,255,255,0.4);border-top:3px solid #fff;border-radius:50%;animation:spin 0.8s linear infinite;vertical-align:middle;margin-right:8px;"></span>Logging in...';
  showAuthMsg('adminMsg','Connecting...','info');
  try {
    await auth.signInWithEmailAndPassword(email, pass);
    showAuthMsg('adminMsg','Login successful! Loading...','success');
  } catch(e) {
    let msg = 'Login failed. Check email and password.';
    if(e.code==='auth/wrong-password')     msg = 'Wrong password. Try again.';
    if(e.code==='auth/invalid-credential') msg = 'Wrong email or password.';
    if(e.code==='auth/too-many-requests')  msg = 'Too many attempts. Try again later.';
    showAuthMsg('adminMsg', msg, 'error');
    btn.disabled = false;
    btn.innerHTML = '⚙️ Login as Admin';
  }
}

async function doRegister(){
  const name  = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const phone = document.getElementById('regPhone').value.trim();
  const pass  = document.getElementById('regPass').value;
  if(!name||!email||!phone||!pass){ showAuthMsg('registerMsg','Please fill all fields.','error'); return; }
  if(pass.length < 6){ showAuthMsg('registerMsg','Password must be at least 6 characters.','error'); return; }
  const btn = document.getElementById('registerBtn');
  btn.disabled = true;
  btn.innerHTML = '<span style="display:inline-block;width:18px;height:18px;border:3px solid rgba(255,255,255,0.4);border-top:3px solid #fff;border-radius:50%;animation:spin 0.8s linear infinite;vertical-align:middle;margin-right:8px;"></span>Submitting...';
  showAuthMsg('registerMsg','Creating your account...','info');
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, pass);
    await cred.user.updateProfile({displayName: name});
    await db.collection('users').doc(cred.user.uid).set({
      name, email, phone, status:'pending',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    await db.collection('requests').doc(cred.user.uid).set({
      name, email, phone, status:'pending', uid: cred.user.uid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    showScreen('pendingScreen');
  } catch(e) {
    let msg = 'Registration failed.';
    if(e.code==='auth/email-already-in-use') msg = 'This email is already registered. Try logging in.';
    if(e.code==='auth/invalid-email')        msg = 'Invalid email address.';
    showAuthMsg('registerMsg', msg, 'error');
    btn.disabled = false;
    btn.innerHTML = 'Request Access';
  }
}

async function doGoogleLogin() {
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    showAuthMsg('loginMsg','Connecting to Google...','info');
    const cred = await auth.signInWithPopup(provider);
    showAuthMsg('loginMsg','Google Login successful! Loading...','success');
    
    // Check if new user via backend doc
    const doc = await db.collection('users').doc(cred.user.uid).get();
    if (!doc.exists) {
      await db.collection('users').doc(cred.user.uid).set({
        name: cred.user.displayName, email: cred.user.email, phone: cred.user.phoneNumber || '', status: 'pending',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      await db.collection('requests').doc(cred.user.uid).set({
        name: cred.user.displayName, email: cred.user.email, phone: cred.user.phoneNumber || '', status: 'pending', uid: cred.user.uid,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      showScreen('pendingScreen');
    } else {
       // If approved, onAuthStateChanged handles routing
       if (doc.data().status === 'pending') showScreen('pendingScreen');
    }
  } catch(e) {
    showAuthMsg('loginMsg', 'Google login failed: ' + e.message, 'error');
    console.error(e);
  }
}

async function checkApproval(){
  if(!currentUser) return;
  try {
    const doc = await db.collection('users').doc(currentUser.uid).get();
    if(!doc.exists || (doc.data() && doc.data().status !== 'approved' && doc.data().status !== 'pending')){
      await auth.signOut();
      showScreen('authScreen');
      showAuthMsg('loginMsg','Account removed or access denied by admin.','error');
    } else if(doc.data()?.status === 'approved') {
      initApp(currentUser);
    }
    else showToast('Still pending. Please wait for admin approval.');
  } catch(e){ showToast('Error checking status. Try again.'); }
}

function doLogout(){
  if(confirm('Are you sure you want to logout?')){
    auth.signOut(); entries = []; showScreen('authScreen');
  }
}

function toggleUserMenu(){ document.getElementById('userMenu').classList.toggle('show'); }
document.addEventListener('click', e => {
  const menu = document.getElementById('userMenu');
  if(menu.classList.contains('show') && !e.target.closest('#userMenu') && !e.target.closest('#userAvatar'))
    menu.classList.remove('show');
});

// -- CLOCK --
function updateClock(){
  const now = new Date();
  document.getElementById('clockTime').textContent = now.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true});
  document.getElementById('clockDate').textContent = now.toLocaleDateString('en-IN',{weekday:'short',day:'numeric',month:'short'});
}
function syncInputTime(){
  const now = new Date();
  document.getElementById('studyDate').value = toLocalDate(now);
  document.getElementById('studyTime').value = p(now.getHours())+':'+p(now.getMinutes());
}

// -- HELPERS --
function toLocalDate(d){ return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); }
function p(n){ return String(n).padStart(2,'0'); }
function calcDates(dateStr, timeStr){
  const [y,m,d] = dateStr.split('-').map(Number);
  const [h,mi]  = (timeStr||'00:00').split(':').map(Number);
  const base = new Date(y,m-1,d,h,mi,0);
  return INTERVALS.map(iv => ({...iv, datetime: new Date(base.getTime()+iv.mins*60000)}));
}
function makeGCalLink(topic, dt, label){
  const fmt = d => `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent('['+label+'] '+topic)}&dates=${fmt(dt)}/${fmt(new Date(dt.getTime()+30*60000))}&details=${encodeURIComponent('Ebbinghaus revision\nInterval: '+label)}&sf=true`;
}
function buildICS(eventsArr){
  const uid = () => Math.random().toString(36).substr(2,9)+Date.now();
  const fmt = d => `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
  let lines = ['BEGIN:VCALENDAR','VERSION:2.0','CALSCALE:GREGORIAN','PRODID:-//StudyTracker//EN','METHOD:PUBLISH'];
  eventsArr.forEach(ev => {
    const dt = ev.datetime instanceof Date ? ev.datetime : new Date(ev.datetime);
    lines.push('BEGIN:VEVENT',`UID:${uid()}@studytracker`,`DTSTAMP:${fmt(new Date())}`,`DTSTART:${fmt(dt)}`,`DTEND:${fmt(new Date(dt.getTime()+30*60000))}`,`SUMMARY:[${ev.label}] ${ev.topic}`,`DESCRIPTION:Ebbinghaus revision\\nInterval: ${ev.label}\\nTopic: ${ev.topic}`,'BEGIN:VALARM','TRIGGER:-PT10M','ACTION:DISPLAY',`DESCRIPTION:Revise: ${ev.topic}`,'END:VALARM','END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
function downloadICS(eventsArr, filename){
  const blob = new Blob([buildICS(eventsArr)],{type:'text/calendar;charset=utf-8'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename||'revisions.ics';
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// -- ADD ENTRY --
let pendingEntry = null;

async function addEntry(){
  const topic   = document.getElementById('topicInput').value.trim();
  const dateStr = document.getElementById('studyDate').value;
  const timeStr = document.getElementById('studyTime').value;
  if(!topic){ showToast('Please enter a topic!'); return; }
  const revisions = calcDates(dateStr, timeStr);
  
  // Store as DRAFT - do NOT save to server yet
  pendingEntry = {
    id: Date.now(), 
    topic, 
    dateStr, 
    timeStr, 
    revisions: revisions.map(r=>({...r, datetime: r.datetime.toISOString()}))
  };

  showResult(pendingEntry, revisions);
  
  document.getElementById('topicInput').value = '';
  showToast('Preview ready! Tap the green button to sync to your calendar.');
  
  setTimeout(() => {
    document.getElementById('resultCard').scrollIntoView({behavior:'smooth', block:'start'});
    // Reset the "Add" button state
    const btn = document.getElementById('addToCalIcsBtn');
    if(btn) {
      btn.innerHTML = '<span style="font-size:1.5rem;">📅</span><div style="text-align:left;"><span style="display:block;font-family:\'Poppins\',sans-serif;font-size:0.88rem;font-weight:700;">Add to Study Calendar</span><span style="display:block;font-size:0.64rem;opacity:0.85;margin-top:1px;">Click to sync all 7 events</span></div>';
      btn.style.background = 'linear-gradient(135deg, #166534, #16a34a)';
      btn.disabled = false;
    }
  }, 120);
}

window.savePendingEntry = async function() {
  if(!pendingEntry) return;
  const btn = document.getElementById('addToCalIcsBtn');
  try {
    btn.innerHTML = '<span>⏳</span><div><span style="display:block;font-weight:700;">Saving...</span></div>';
    btn.disabled = true;

    // COMMIT: Save to local array and cloud DB
    entries.unshift(pendingEntry);
    await saveEntry(pendingEntry);
    updateTodayBadge();
    
    btn.innerHTML = '<span>✅</span><div><span style="display:block;font-weight:700;">Added to Calendar!</span><span style="display:block;font-size:0.64rem;">Sync Successful</span></div>';
    btn.style.background = 'linear-gradient(135deg, #059669, #10b981)';
    showToast('Success! Schedule saved to database.');
    pendingEntry = null;
  } catch(e) {
    showToast('Error: ' + e.message);
    btn.disabled = false;
  }
}

function showResult(entry, revisions){
  document.getElementById('resultCard').style.display = 'block';
  document.getElementById('resultTopic').textContent  = entry.topic;
  _gcEntry=entry; _gcRevs=revisions;
  document.getElementById('intervalsList').innerHTML = revisions.map((r,i) => {
    const dl = r.datetime.toLocaleDateString('en-IN',{weekday:'short',day:'numeric',month:'short',year:'numeric'});
    const tl = r.datetime.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});
    return `<div class="iv-row" id="ivrow-${i}"><span class="iv-tag ${r.type}">${r.label}</span><div class="iv-info"><div class="iv-date">${dl}</div><div class="iv-time">${tl}</div></div></div>`;
  }).join('');
}

async function startAddingToCalendar(topic, revisions){
  // ONE CLICK - ICS download for ALL devices (Android, iPhone, Windows)
  // No multiple tabs, no popup blocking, works with Google Calendar directly
  const eventsArr = revisions.map(r=>({
    topic,
    datetime: r.datetime instanceof Date ? r.datetime : new Date(r.datetime),
    label: r.label
  }));
  downloadICS(eventsArr, `revisions-${topic.slice(0,20).replace(/\s+/g,'-')}.ics`);
  // Mark all as opened in UI
  revisions.forEach((r,i)=>{
    const row = document.getElementById('ivrow-'+i);
    if(row){
      row.style.background='#0d2a1a';
      if(!row.querySelector('.iv-status')){
        const b=document.createElement('span'); b.className='iv-status'; b.textContent='Added'; row.appendChild(b);
      }
    }
  });
  showToast('📅 ICS file downloaded! Open it - all 7 events will be added to Google Calendar automatically!');
}
function cancelProgress(){ cancelFlag=true; document.getElementById('progressOverlay').classList.remove('show'); }

// -- TODAY --
function getDoneSet(){
  const today = toLocalDate(new Date());
  return new Set(JSON.parse(localStorage.getItem('ebbing_done_'+today)||'[]'));
}
function getTodayItems(){
  const today   = toLocalDate(new Date());
  const doneSet = getDoneSet();
  const items   = [];
  entries.forEach(entry => {
    entry.revisions.forEach(r => {
      if(toLocalDate(new Date(r.datetime)) === today){
        const key = entry.id+'_'+r.label;
        items.push({topic:entry.topic,label:r.label,datetime:r.datetime,key,done:doneSet.has(key),link:makeGCalLink(entry.topic,new Date(r.datetime),r.label)});
      }
    });
  });
  return items.sort((a,b) => new Date(a.datetime)-new Date(b.datetime));
}

window.bulkNotifyToday = async function() {
  console.log("🔔 Bulk Notify Triggered");
  const items = getTodayItems();
  if (items.length === 0) return showToast("Nothing scheduled for today!");
  
  const isIPad = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isPWA = window.matchMedia('(display-mode: standalone)').matches || (window.navigator && window.navigator.standalone);

  if (isIPad && !isPWA) {
    return showToast("📱 iPad Alert: Please 'Add to Home Screen' to enable notifications.");
  }

  if (!window.Notification) {
    return showToast("Browser does not support notifications.");
  }

  if (Notification.permission !== "granted") {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      return showToast("⚠️ Notification permission denied. Check settings.");
    }
  }

  items.forEach((item, idx) => {
    setTimeout(() => {
      try {
        new Notification(`Revise: ${item.topic}`, {
          body: `Due Now: ${item.label}`,
          icon: './icon-192.png',
          tag: 'study-rem'
        });
      } catch(e) { console.error("Notification failed:", e); }
    }, idx * 150);
  });
  
  showToast(`🔔 ${items.length} Alerts pushed!`);
}
function toggleDone(key){
  const today = toLocalDate(new Date());
  const sk    = 'ebbing_done_'+today;
  const set   = new Set(JSON.parse(localStorage.getItem(sk)||'[]'));
  if(set.has(key)) set.delete(key); else set.add(key);
  localStorage.setItem(sk, JSON.stringify([...set]));
  renderToday(); updateTodayBadge();
}
function resetDone(){
  localStorage.removeItem('ebbing_done_'+toLocalDate(new Date()));
  renderToday(); updateTodayBadge(); showToast('Checkboxes reset!');
}
function updateTodayBadge(){
  const items   = getTodayItems();
  const pending = items.filter(i=>!i.done).length;
  const badge   = document.getElementById('todayCount');
  if(pending>0){ badge.textContent=pending; badge.style.display='inline-block'; badge.style.background='var(--teal)'; }
  else if(items.length>0){ badge.textContent='✓'; badge.style.display='inline-block'; badge.style.background='var(--green)'; }
  else badge.style.display='none';
}
function renderToday(){
  const items = getTodayItems();
  const c     = document.getElementById('todayContent');
  const dl    = new Date().toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  if(!items.length){ c.innerHTML=`<div class="empty-state"><span class="emoji">✅</span><p>Nothing to revise today.<br><span style="font-size:0.76rem;color:var(--text-dim)">${dl}</span></p></div>`; return; }
  c.innerHTML = `<div class="card card-green"><div class="card-header"><div class="live-dot"></div><h3>Revise Today</h3><span class="meta">${new Date().toLocaleDateString('en-IN',{day:'numeric',month:'short'})}</span></div><div style="padding:12px 16px 10px;"><button class="btn-gcal" id="todayCalBtn"><svg class="btn-gcal-icon" viewBox="0 0 48 48"><rect x="6" y="10" width="36" height="32" rx="3" fill="white"/><rect x="6" y="10" width="36" height="10" rx="3" fill="#1a73e8"/><rect x="6" y="16" width="36" height="4" fill="#1a73e8"/><rect x="16" y="6" width="4" height="8" rx="2" fill="#5f6368"/><rect x="28" y="6" width="4" height="8" rx="2" fill="#5f6368"/><text x="24" y="36" text-anchor="middle" font-size="13" font-weight="bold" fill="#1a73e8" font-family="Arial">24</text></svg><div><span class="line1">Add Today's ${items.length} Revisions</span><span class="line2">Opens your default calendar app</span></div></button></div><div style="padding:2px 16px 6px;"><div style="font-size:0.56rem;color:var(--text-dim);letter-spacing:0.1em;text-transform:uppercase;padding:8px 0 4px;border-top:1px solid var(--border);font-weight:600;">Today's Revision List</div></div>${items.map(item=>`<div class="today-item ${item.done?'done-item':''}" id="ti-${item.key}"><button class="check-btn ${item.done?'done':''}" onclick="toggleDone('${item.key}')"><svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M2 7L6 11L12 3" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button><span class="today-badge">${item.label}</span><span class="today-topic">${item.topic}</span></div>`).join('')}<div class="done-summary"><span>✅ ${items.filter(i=>i.done).length} / ${items.length} done</span>${items.filter(i=>i.done).length>0?`<button class="reset-btn" onclick="resetDone()">Reset</button>`:''}</div></div>`;
  document.getElementById('todayCalBtn').onclick = () => {
    const evtsArr = items.map(it=>({topic:it.topic, datetime:new Date(it.datetime), label:it.label}));
    downloadICS(evtsArr, 'todays-revisions.ics');
    showToast('📅 ICS file downloaded! Open it - all revisions added to Google Calendar!');
  };
}

// -- LOG --
function renderLog(){
  const total    = entries.length;
  const totalRev = entries.reduce((a,e)=>a+e.revisions.length,0);
  const todayN   = getTodayItems().length;
  document.getElementById('statsRow').innerHTML = `<div class="stat-box"><div class="stat-num">${total}</div><div class="stat-lbl">Topics</div></div><div class="stat-box"><div class="stat-num">${totalRev}</div><div class="stat-lbl">Revisions</div></div><div class="stat-box"><div class="stat-num">${todayN}</div><div class="stat-lbl">Due Today</div></div>`;
  renderPerformanceScore();
  const c = document.getElementById('logContainer');
  if(!entries.length){ c.innerHTML='<div class="empty-state"><span class="emoji">📖</span><p>No entries yet.</p></div>'; return; }
  const filtered = searchQuery ? entries.filter(e=>e.topic.toLowerCase().includes(searchQuery)) : entries;
  if(!filtered.length){ c.innerHTML=`<div class="empty-state"><span class="emoji">🔍</span><p>No topics found for "${searchQuery}"</p></div>`; return; }
  c.innerHTML = filtered.map(entry => {
    const [y,m,d] = entry.dateStr.split('-').map(Number);
    const dl      = new Date(y,m-1,d).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'});
    const topic   = searchQuery ? entry.topic.replace(new RegExp('('+searchQuery+')','gi'),'<mark style="background:#fef9c3;border-radius:3px;padding:0 2px;">$1</mark>') : entry.topic;
    return `<div class="log-item"><div class="log-left"><div class="log-topic">${topic}</div><div class="log-meta">${dl} · ${entry.timeStr} · 7 revisions</div></div><div class="log-actions"><button class="btn-sm" onclick="reOpen(${entry.id})">View</button><button class="btn-sm del" onclick="deleteEntry(${entry.id})">✕</button></div></div>`;
  }).join('');
}
function reOpen(id){
  const entry = entries.find(e=>e.id==id); if(!entry)return;
  const revisions = entry.revisions.map(r=>({...r,datetime:new Date(r.datetime)}));
  switchTab('add');
  setTimeout(()=>{ showResult(entry,revisions); document.getElementById('resultCard').scrollIntoView({behavior:'smooth'}); },200);
}
async function deleteEntry(id){
  if(!confirm('Remove this entry?')) return;
  entries = entries.filter(e=>e.id!=id);
  await deleteEntryFromDB(id);
  renderLog(); updateTodayBadge(); showToast('Entry removed');
}
function filterLog(){
  searchQuery = document.getElementById('searchInput').value.toLowerCase().trim();
  const cb = document.getElementById('searchClear');
  if(cb) cb.style.display = searchQuery ? 'block' : 'none';
  renderLog();
}
function clearSearch(){
  document.getElementById('searchInput').value = '';
  searchQuery = '';
  const cb = document.getElementById('searchClear');
  if(cb) cb.style.display = 'none';
  renderLog();
}

// -- DASHBOARD --
function renderCountdown(){
  const dates = JSON.parse(localStorage.getItem('ebbing_examdates_'+(currentUser?.uid||''))||'{}');
  const today = new Date(); today.setHours(0,0,0,0);
  function setBox(daysEl,dateEl,dateStr){
    if(!dateStr){ daysEl.textContent='--'; dateEl.textContent='Tap Set Dates'; daysEl.className='exam-days ok'; return; }
    const exam = new Date(dateStr); exam.setHours(0,0,0,0);
    const diff = Math.ceil((exam-today)/(1000*60*60*24));
    daysEl.textContent = diff>0 ? diff : 'Done!';
    dateEl.textContent = exam.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'});
    daysEl.className = 'exam-days '+(diff<=30?'urgent':diff<=60?'soon':'ok');
  }
  setBox(document.getElementById('mainDays'),document.getElementById('mainDateDisp'),dates.mains);
  setBox(document.getElementById('advDays'),document.getElementById('advDateDisp'),dates.adv);
}
function openExamModal(){
  const dates = JSON.parse(localStorage.getItem('ebbing_examdates_'+(currentUser?.uid||''))||'{}');
  if(dates.mains) document.getElementById('mainDate').value = dates.mains;
  if(dates.adv)   document.getElementById('advDate').value  = dates.adv;
  document.getElementById('examModal').classList.add('show');
}
function closeExamModal(){ document.getElementById('examModal').classList.remove('show'); }
async function saveExamDates(){
  const mains=document.getElementById('mainDate').value;
  const adv=document.getElementById('advDate').value;
  const data={mains,adv};
  localStorage.setItem('ebbing_examdates_'+(currentUser?.uid||''),JSON.stringify(data));
  try{await db.collection('users').doc(currentUser.uid).collection('settings').doc('examdates').set(data);}catch(e){}
  closeExamModal(); renderCountdown(); showToast('Exam dates saved!');
}
function renderSubjects(){
  const subjects = {Physics:{icon:'⚡',topics:0},Chemistry:{icon:'🧪',topics:0},Maths:{icon:'📐',topics:0}};
  const total = entries.length || 1;
  entries.forEach(entry => {
    const t = entry.topic.toLowerCase();
    if(t.includes('phy')||t.includes('motion')||t.includes('force')||t.includes('energy')||t.includes('wave')||t.includes('optic')||t.includes('electric')||t.includes('magnet')||t.includes('thermo')) subjects.Physics.topics++;
    else if(t.includes('chem')||t.includes('organic')||t.includes('inorganic')||t.includes('acid')||t.includes('reaction')||t.includes('element')||t.includes('bond')||t.includes('mole')) subjects.Chemistry.topics++;
    else if(t.includes('math')||t.includes('calculus')||t.includes('algebra')||t.includes('trigon')||t.includes('coordinate')||t.includes('vector')||t.includes('matrix')||t.includes('integral')||t.includes('differenti')||t.includes('equation')||t.includes('quadratic')) subjects.Maths.topics++;
    else subjects.Physics.topics++;
  });
  document.getElementById('subjRow').innerHTML = ['Physics','Chemistry','Maths'].map(name => {
    const s   = subjects[name];
    const pct = Math.round(s.topics/total*100);
    const cls = name==='Physics'?'subj-phy':name==='Chemistry'?'subj-chem':'subj-math';
    return `<div class="subj-card ${cls}"><div class="s-icon">${s.icon}</div><div class="s-name">${name}</div><div class="s-num">${s.topics}</div><div class="s-lbl">topics</div><div class="s-bar-wrap"><div class="s-bar" style="width:${pct}%"></div></div></div>`;
  }).join('');
}
function calcStreak(){
  const studyDays = new Set(entries.map(e=>e.dateStr));
  let current=0,longest=0,temp=0;
  const today = new Date();
  for(let i=0;i<365;i++){
    const d = new Date(today); d.setDate(d.getDate()-i);
    if(studyDays.has(toLocalDate(d))){ temp++; if(i===0||i===1) current=temp; }
    else{ if(i<=1) current=0; longest=Math.max(longest,temp); temp=0; }
  }
  return {current, longest:Math.max(longest,temp), total:studyDays.size};
}
function renderStreak(){
  const {current,longest,total} = calcStreak();
  document.getElementById('streakRow').innerHTML = `<div class="streak-box"><div class="streak-icon">🔥</div><div class="streak-num">${current}</div><div class="streak-lbl">Current Streak</div></div><div class="streak-box"><div class="streak-icon">🏆</div><div class="streak-num">${longest}</div><div class="streak-lbl">Best Streak</div></div><div class="streak-box"><div class="streak-icon">📅</div><div class="streak-num">${total}</div><div class="streak-lbl">Days Studied</div></div>`;
}
function renderHeatmap(){
  const studyCount = {};
  entries.forEach(e=>{ studyCount[e.dateStr]=(studyCount[e.dateStr]||0)+1; });
  const grid  = document.getElementById('heatmapGrid');
  const today = new Date(); today.setHours(0,0,0,0);
  const weeks = 26;
  const start = new Date(today); start.setDate(start.getDate()-weeks*7+1);
  const dow   = start.getDay(); start.setDate(start.getDate()-(dow===0?6:dow-1));
  let html=''; let currentMonth=-1;
  for(let w=0;w<weeks+1;w++){
    let wh='',ml='';
    for(let d2=0;d2<7;d2++){
      const cur = new Date(start); cur.setDate(start.getDate()+w*7+d2);
      if(cur>today){ wh+='<div class="hday" style="background:transparent"></div>'; continue; }
      if(cur.getMonth()!==currentMonth){ currentMonth=cur.getMonth(); ml=cur.toLocaleDateString('en-IN',{month:'short'}); }
      const ds  = toLocalDate(cur);
      const cnt = studyCount[ds]||0;
      const lvl = cnt===0?0:cnt===1?1:cnt<=2?2:cnt<=4?3:4;
      wh += `<div class="hday hday-${lvl}"></div>`;
    }
    html += `<div class="heatmap-month"><div class="heatmap-month-label">${ml||''}</div><div class="heatmap-week">${wh}</div></div>`;
  }
  grid.innerHTML = html;
  document.getElementById('heatmapSub').textContent = `${Object.keys(studyCount).length} days studied · ${entries.length} topics logged`;
}
function renderDashboard(){ renderCountdown(); renderSubjects(); renderStreak(); renderHeatmap(); }

// -- PERFORMANCE SCORE --
function calcPerformanceScore(){
  if(!entries.length) return {score:0,done:0,pending:0,label:'Start studying!'};
  const today  = new Date(); today.setHours(0,0,0,0);
  const allDone = new Set();
  for(let i=0;i<30;i++){
    const d = new Date(today); d.setDate(d.getDate()-i);
    const stored = JSON.parse(localStorage.getItem('ebbing_done_'+toLocalDate(d))||'[]');
    stored.forEach(k=>allDone.add(k));
  }
  let totalDue=0, totalDone=0;
  entries.forEach(entry => {
    entry.revisions.forEach(r => {
      const rDate = new Date(r.datetime); rDate.setHours(0,0,0,0);
      if(rDate <= today){ totalDue++; if(allDone.has(entry.id+'_'+r.label)) totalDone++; }
    });
  });
  const score   = totalDue>0 ? Math.round(totalDone/totalDue*100) : 0;
  const pending = totalDue - totalDone;
  const label   = score>=90?'🔥 Excellent!':score>=70?'✅ Good progress!':score>=50?'📈 Getting there!':score>=30?'💪 Keep pushing!':'🚀 Just getting started!';
  return {score,done:totalDone,pending,label};
}
function renderPerformanceScore(){
  if(!entries.length){ document.getElementById('perfCard').style.display='none'; return; }
  const {score,done,pending,label} = calcPerformanceScore();
  const {current} = calcStreak();
  document.getElementById('perfCard').style.display = 'block';
  document.getElementById('perfScore').innerHTML    = score+'<span>%</span>';
  document.getElementById('perfBar').style.width    = score+'%';
  document.getElementById('perfLabel').textContent  = label;
  document.getElementById('perfDone').textContent   = done;
  document.getElementById('perfPending').textContent = pending;
  document.getElementById('perfStreak').textContent = current;
}

// -- PUSH NOTIFICATIONS --
async function toggleNotifications(){
  if(!('Notification' in window)){ showToast('Push notifications not supported on this browser.'); return; }
  if(Notification.permission==='granted'){ showToast('Notifications are ON! You will be reminded for revisions.'); return; }
  if(Notification.permission==='denied'){  showToast('Notifications blocked. Please enable in browser settings.'); return; }
  const result = await Notification.requestPermission();
  updateNotifUI();
  if(result==='granted'){
    showToast('Notifications enabled! You will get revision reminders.');
    
    // Save Push Subscription to Firestore
    if ('serviceWorker' in navigator && 'PushManager' in window && currentUser) {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: 'BEEQx-o45PHXez8mhD8KZR1aISwH-yDt4bRZNLq1O8reA3dcWfgS1LvLRPHYX-wG0fkrhevh_PJ-G_QP5pi5GY' // Public VAPID Key
        });
        await db.collection('users').doc(currentUser.uid).set({ pushSubscription: JSON.parse(JSON.stringify(sub)) }, {merge:true});
      } catch(e) { console.error('Push Sub Error:', e); }
    }

    scheduleRevisionNotifications();
    setTimeout(()=>new Notification('Study Tracker',{body:'Notifications are working! You will be reminded for revisions.',icon:'/icon-192.png'}),1000);
  } else {
    showToast('Notification permission denied.');
  }
}
function updateNotifUI(){
  const btn = document.getElementById('notifStatus');
  const sub = document.getElementById('notifSubText');
  if(!btn||!sub) return;
  const perm = Notification?.permission || 'default';
  if(perm==='granted'){ btn.className='nb-status on'; btn.textContent='ON'; sub.textContent='Reminders enabled for today\'s revisions'; }
  else if(perm==='denied'){ btn.className='nb-status off'; btn.textContent='BLOCKED'; sub.textContent='Enable in browser settings'; }
  else { btn.className='nb-status off'; btn.textContent='OFF'; sub.textContent='Tap to enable push notifications'; }
}
function scheduleRevisionNotifications(){
  if(Notification.permission!=='granted') return;
  const items = getTodayItems();
  if(!items.length) return;
  const now = new Date();
  items.forEach(item => {
    const dt    = new Date(item.datetime);
    const delay = dt.getTime()-now.getTime();
    if(delay>0 && delay<24*60*60*1000){
      setTimeout(()=>new Notification('📚 Time to Revise!',{body:'['+item.label+'] '+item.topic,icon:'/icon-192.png',tag:item.key}),delay);
    }
  });
}

// -- BACKUP --
function checkBackupReminder(){
  const last = parseInt(localStorage.getItem('ebbing_lastreminder_'+(currentUser?.uid||''))||'0');
  if(entries.length>0 && (Date.now()-last)>7*24*60*60*1000)
    document.getElementById('backupBanner').classList.add('show');
}
document.getElementById('backupNowBtn').onclick = ()=>{ exportData(); document.getElementById('backupBanner').classList.remove('show'); localStorage.setItem('ebbing_lastreminder_'+(currentUser?.uid||''),Date.now()); };
document.getElementById('backupDismiss').onclick = ()=>{ document.getElementById('backupBanner').classList.remove('show'); localStorage.setItem('ebbing_lastreminder_'+(currentUser?.uid||''),Date.now()); };
function exportData(){
  if(!entries.length){ showToast('No data to export!'); return; }
  const backup = {version:'2.0',exportDate:new Date().toISOString(),appName:'Study Tracker',user:currentUser?.email,totalEntries:entries.length,entries};
  const blob   = new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement('a');
  const ds     = new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'2-digit',year:'numeric'}).replace(/\//g,'-');
  a.href=url; a.download=`studytracker-backup-${ds}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  const now = new Date().toLocaleString('en-IN');
  localStorage.setItem('ebbing_lastbackup_'+(currentUser?.uid||''),now);
  localStorage.setItem('ebbing_lastreminder_'+(currentUser?.uid||''),Date.now());
  updateLastBackupInfo();
  showToast(`Backup saved! ${entries.length} entries exported.`);
}
document.getElementById('importFileInput').onchange = function(e){
  const file = e.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = async function(ev){
    try {
      const backup = JSON.parse(ev.target.result);
      if(!backup.entries||!Array.isArray(backup.entries)){ showToast('Invalid backup file!'); return; }
      if(!confirm(`Import ${backup.entries.length} entries? This will replace current data.`)) return;
      entries = backup.entries;
      for(const entry of entries) await saveEntry(entry);
      renderLog(); updateTodayBadge();
      showToast(`Imported ${entries.length} entries!`); switchTab('log');
    } catch(err){ showToast('Could not read file.'); }
  };
  reader.readAsText(file); this.value='';
};
function updateLastBackupInfo(){
  const last = localStorage.getItem('ebbing_lastbackup_'+(currentUser?.uid||''));
  document.getElementById('lastBackupInfo').textContent = last ? `Last backed up: ${last}` : 'No backup taken yet';
}

// -- TABS --
function switchTab(name){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  ['add','today','dash','log','tools','backup'].forEach((n,i)=>{ if(n===name) document.querySelectorAll('.tab')[i].classList.add('active'); });
  if(document.getElementById('nav-'+name)) document.getElementById('nav-'+name).classList.add('active');
  if(name==='today')  renderToday();
  if(name==='log')    renderLog();
  if(name==='dash')   renderDashboard();
  if(name==='backup') updateLastBackupInfo();
}

// -- PDF REPORT --
function downloadPDFReport(){
  if(!entries.length){ showToast('No data yet! Add some topics first.'); return; }
  const {score,done,pending} = calcPerformanceScore();
  const {current,longest,total} = calcStreak();
  const todayItems = getTodayItems();
  const pendingToday = todayItems.filter(i=>!i.done);
  const subjects = {Physics:0,Chemistry:0,Maths:0,Other:0};
  entries.forEach(e=>{
    const t=e.topic.toLowerCase();
    if(t.includes('phy')||t.includes('motion')||t.includes('force')||t.includes('energy')||t.includes('wave')||t.includes('optic')||t.includes('electric')||t.includes('magnet')||t.includes('thermo')) subjects.Physics++;
    else if(t.includes('chem')||t.includes('organic')||t.includes('inorganic')||t.includes('acid')||t.includes('reaction')||t.includes('element')||t.includes('bond')||t.includes('mole')) subjects.Chemistry++;
    else if(t.includes('math')||t.includes('calculus')||t.includes('algebra')||t.includes('trigon')||t.includes('vector')||t.includes('matrix')||t.includes('integral')||t.includes('differenti')||t.includes('equation')||t.includes('quadratic')) subjects.Maths++;
    else subjects.Other++;
  });
  const totalRevisions = entries.reduce((a,e)=>a+e.revisions.length,0);
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const userName = currentUser?.displayName || currentUser?.email || 'Student';

  const win = window.open('','_blank');
  win.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Study Tracker - Progress Report</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Poppins:wght@700;800&display=swap');
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Inter',sans-serif;background:#f8f9fc;color:#0f172a;padding:30px;}
  .header{background:linear-gradient(135deg,#0284c7,#0ea5e9);border-radius:16px;padding:28px;color:#fff;margin-bottom:24px;text-align:center;}
  .header h1{font-family:'Poppins',sans-serif;font-size:1.8rem;font-weight:800;margin-bottom:4px;}
  .header p{font-size:0.85rem;opacity:0.85;}
  .header .date{font-size:0.75rem;opacity:0.7;margin-top:6px;}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px;}
  .grid4{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:24px;}
  .card{background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 6px rgba(0,0,0,0.08);}
  .card h3{font-size:0.6rem;color:#94a3b8;text-transform:uppercase;letter-spacing:0.1em;font-weight:600;margin-bottom:8px;}
  .big-num{font-family:'Poppins',sans-serif;font-size:2.5rem;font-weight:800;color:#0ea5e9;line-height:1;}
  .label{font-size:0.7rem;color:#475569;margin-top:4px;}
  .score-card{background:linear-gradient(135deg,#0ea5e9,#0284c7);color:#fff;border-radius:12px;padding:20px;margin-bottom:24px;}
  .score-card h3{font-size:0.65rem;opacity:0.8;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:10px;}
  .score-row{display:flex;align-items:center;gap:20px;}
  .score-num{font-family:'Poppins',sans-serif;font-size:3.5rem;font-weight:800;line-height:1;}
  .score-bar-wrap{flex:1;background:rgba(255,255,255,0.3);border-radius:100px;height:10px;overflow:hidden;}
  .score-bar{height:100%;background:#fff;border-radius:100px;}
  .score-label{font-size:0.8rem;opacity:0.9;margin-bottom:8px;}
  .subj-card{background:#fff;border-radius:12px;padding:14px;box-shadow:0 1px 6px rgba(0,0,0,0.08);}
  .subj-card h3{font-size:0.6rem;color:#94a3b8;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:12px;}
  .subj-row{display:flex;align-items:center;gap:10px;margin-bottom:8px;}
  .subj-name{font-size:0.78rem;font-weight:600;width:80px;}
  .subj-bar-wrap{flex:1;background:#f1f5f9;border-radius:100px;height:8px;overflow:hidden;}
  .subj-bar-phy{height:100%;background:linear-gradient(90deg,#1a6abf,#3d9bef);border-radius:100px;}
  .subj-bar-chem{height:100%;background:linear-gradient(90deg,#27ae60,#5dd88a);border-radius:100px;}
  .subj-bar-math{height:100%;background:linear-gradient(90deg,#c97a2a,#f0a840);border-radius:100px;}
  .subj-bar-other{height:100%;background:linear-gradient(90deg,#7c3aed,#a78bfa);border-radius:100px;}
  .subj-count{font-size:0.72rem;color:#475569;font-weight:600;width:20px;text-align:right;}
  .pending-list{background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 6px rgba(0,0,0,0.08);margin-bottom:24px;}
  .pending-list h3{font-size:0.6rem;color:#94a3b8;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:12px;}
  .pending-item{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:0.78rem;}
  .pending-item:last-child{border-bottom:none;}
  .p-badge{background:#e0f2fe;color:#0284c7;border:1px solid #bae6fd;border-radius:6px;padding:2px 8px;font-size:0.62rem;font-weight:600;white-space:nowrap;}
  .recent-list{background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 6px rgba(0,0,0,0.08);}
  .recent-list h3{font-size:0.6rem;color:#94a3b8;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:12px;}
  .recent-item{padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:0.78rem;color:#475569;}
  .recent-item:last-child{border-bottom:none;}
  .footer{text-align:center;margin-top:24px;font-size:0.65rem;color:#94a3b8;}
  @media print{body{padding:15px;}button{display:none!important;}}
</style>
</head>
<body>
<div class="header">
  <h1>📚 Study Tracker</h1>
  <p>Progress Report - ${userName}</p>
  <div class="date">Generated on ${dateStr}</div>
</div>

<div class="score-card">
  <h3>🏆 Overall Performance Score</h3>
  <div class="score-row">
    <div class="score-num">${score}<span style="font-size:1.5rem;opacity:0.8">%</span></div>
    <div style="flex:1">
      <div class="score-label">${score>=90?'🔥 Excellent! Keep it up!':score>=70?'✅ Good progress!':score>=50?'📈 Getting there!':score>=30?'💪 Keep pushing!':'🚀 Just getting started!'}</div>
      <div class="score-bar-wrap"><div class="score-bar" style="width:${score}%"></div></div>
      <div style="display:flex;gap:20px;margin-top:12px;">
        <div style="text-align:center"><div style="font-family:Poppins;font-size:1.3rem;font-weight:700">${done}</div><div style="font-size:0.6rem;opacity:0.75;text-transform:uppercase">Revised</div></div>
        <div style="text-align:center"><div style="font-family:Poppins;font-size:1.3rem;font-weight:700">${pending}</div><div style="font-size:0.6rem;opacity:0.75;text-transform:uppercase">Pending</div></div>
        <div style="text-align:center"><div style="font-family:Poppins;font-size:1.3rem;font-weight:700">${current}</div><div style="font-size:0.6rem;opacity:0.75;text-transform:uppercase">Streak</div></div>
      </div>
    </div>
  </div>
</div>

<div class="grid4">
  <div class="card"><h3>Topics</h3><div class="big-num">${entries.length}</div><div class="label">Total logged</div></div>
  <div class="card"><h3>Revisions</h3><div class="big-num">${totalRevisions}</div><div class="label">Scheduled</div></div>
  <div class="card"><h3>Best Streak</h3><div class="big-num">${longest}</div><div class="label">Days in a row</div></div>
  <div class="card"><h3>Days Studied</h3><div class="big-num">${total}</div><div class="label">Total days</div></div>
</div>

<div class="subj-card" style="margin-bottom:24px;">
  <h3>📚 Subject Breakdown</h3>
  <div class="subj-row"><div class="subj-name">⚡ Physics</div><div class="subj-bar-wrap"><div class="subj-bar-phy" style="width:${Math.min(subjects.Physics/Math.max(entries.length,1)*100,100)}%"></div></div><div class="subj-count">${subjects.Physics}</div></div>
  <div class="subj-row"><div class="subj-name">🧪 Chemistry</div><div class="subj-bar-wrap"><div class="subj-bar-chem" style="width:${Math.min(subjects.Chemistry/Math.max(entries.length,1)*100,100)}%"></div></div><div class="subj-count">${subjects.Chemistry}</div></div>
  <div class="subj-row"><div class="subj-name">📐 Maths</div><div class="subj-bar-wrap"><div class="subj-bar-math" style="width:${Math.min(subjects.Maths/Math.max(entries.length,1)*100,100)}%"></div></div><div class="subj-count">${subjects.Maths}</div></div>
  <div class="subj-row"><div class="subj-name">📖 Other</div><div class="subj-bar-wrap"><div class="subj-bar-other" style="width:${Math.min(subjects.Other/Math.max(entries.length,1)*100,100)}%"></div></div><div class="subj-count">${subjects.Other}</div></div>
</div>

${pendingToday.length>0?`
<div class="pending-list">
  <h3>⏰ Pending Revisions Today (${pendingToday.length})</h3>
  ${pendingToday.map(item=>`<div class="pending-item"><span class="p-badge">${item.label}</span><span>${item.topic}</span></div>`).join('')}
</div>`:'<div class="pending-list"><h3>✅ Today\'s Revisions</h3><div style="font-size:0.82rem;color:#16a34a;font-weight:600;padding:8px 0;">All revisions completed for today! 🎉</div></div>'}

<div class="recent-list">
  <h3>📖 All Topics & Revision Schedule</h3>
  ${entries.map((e,i)=>{
    const doneCount = e.revisions.filter(r=>r.done).length;
    const totalRev = e.revisions.length;
    const revRows = e.revisions.map(r=>`
      <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid #f8fafc;">
        <span style="background:${r.done?'#dcfce7':'#fef3c7'};color:${r.done?'#16a34a':'#d97706'};border-radius:4px;padding:1px 7px;font-size:0.58rem;font-weight:600;min-width:60px;text-align:center;">${r.label}</span>
        <span style="font-size:0.68rem;color:#64748b;flex:1;">${r.dateStr||''}</span>
        <span style="font-size:0.68rem;font-weight:600;color:${r.done?'#16a34a':'#d97706'}">${r.done?'Done':'Pending'}</span>
      </div>`).join('');
    return `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px;margin-bottom:10px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <span style="background:#e0f2fe;color:#0284c7;border-radius:6px;padding:2px 8px;font-size:0.62rem;font-weight:700;">#${i+1}</span>
        <span style="font-size:0.82rem;font-weight:600;color:#0f172a;flex:1;">${e.topic}</span>
        <span style="font-size:0.65rem;color:#94a3b8;">${e.dateStr}</span>
        <span style="font-size:0.65rem;font-weight:600;color:${doneCount===totalRev?'#16a34a':'#d97706'}">${doneCount}/${totalRev} done</span>
      </div>
      <div style="padding-left:4px;">${revRows}</div>
    </div>`;
  }).join('')}
</div>

<div class="footer">
  Study Tracker - JEE Spaced Repetition System · study-five-umber.vercel.app
</div>

<div style="text-align:center;margin-top:20px;">
  <button onclick="window.print()" style="background:linear-gradient(135deg,#0284c7,#0ea5e9);color:#fff;border:none;border-radius:10px;padding:14px 32px;font-family:Poppins,sans-serif;font-size:0.9rem;font-weight:700;cursor:pointer;">🖨️ Save as PDF / Print</button>
</div>
</body></html>`);
  win.document.close();
  showToast('📄 Report opened! Tap "Save as PDF" button in the report.');
}




// DARK MODE
function toggleTheme(){
  const isDark = document.body.classList.toggle('dark-mode');
  document.getElementById('themeBtn').textContent = isDark ? '☀️' : '🌙';
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
}
function loadTheme(){
  const saved = localStorage.getItem('theme');
  if(saved === 'dark'){
    document.body.classList.add('dark-mode');
    const btn = document.getElementById('themeBtn');
    if(btn) btn.textContent = '☀️';
  }
}

// -- TOAST --
function showToast(msg){
  const ex = document.querySelector('.toast'); if(ex) ex.remove();
  const t  = document.createElement('div'); t.className='toast'; t.textContent=msg;
  document.body.appendChild(t); setTimeout(()=>t.remove(),3400);
}

// ===================== NEW FEATURES =====================

// --- Offline banner (created via JS, never blocks HTML) ---
(function(){
  var b=document.createElement('div');
  b.id='_ob';
  b.style.cssText='display:none;position:fixed;top:0;left:0;right:0;background:#dc2626;color:#fff;text-align:center;padding:8px;font-size:0.75rem;font-weight:600;z-index:9999;pointer-events:none;';
  b.textContent='No internet - data saved locally';
  document.body.appendChild(b);
  function chk(){b.style.display=navigator.onLine?'none':'block';}
  window.addEventListener('online',chk);window.addEventListener('offline',chk);chk();
})();

// --- Target modal (created via JS) ---
(function(){
  var m=document.createElement('div');
  m.id='_tm';
  m.style.cssText='display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:6001;align-items:center;justify-content:center;padding:20px;';
  m.innerHTML='<div style="background:#fff;border-radius:20px;padding:24px;width:100%;max-width:320px;box-shadow:0 20px 60px rgba(0,0,0,0.2);">'
    +'<div style="font-family:Poppins,sans-serif;font-size:1rem;font-weight:700;margin-bottom:12px;">Set Daily Study Target</div>'
    +'<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px;" id="_to">'
    +[4,5,6,7,8,10].map(function(h){return '<div onclick="pickTgt('+h+')" data-h="'+h+'" style="background:#f1f5f9;border:1.5px solid #cbd5e1;border-radius:10px;padding:10px 4px;text-align:center;cursor:pointer;">'
      +'<div style="font-family:Poppins,sans-serif;font-size:1.3rem;font-weight:700;color:#d97706;">'+h+'</div>'
      +'<div style="font-size:0.55rem;color:#94a3b8;">hours</div></div>';}).join('')
    +'</div>'
    +'<div style="display:flex;gap:10px;">'
    +'<button onclick="closeTgtModal()" style="flex:1;background:#f1f5f9;border:1px solid #cbd5e1;color:#475569;border-radius:10px;padding:12px;font-family:Inter,sans-serif;font-size:0.8rem;cursor:pointer;">Cancel</button>'
    +'<button onclick="saveTgt()" style="flex:2;background:linear-gradient(135deg,#d97706,#f59e0b);color:#fff;border:none;border-radius:10px;padding:12px;font-family:Poppins,sans-serif;font-size:0.82rem;font-weight:700;cursor:pointer;">Save</button>'
    +'</div></div>';
  document.body.appendChild(m);
})();

// --- Target functions ---
var _st=6;
function openTgtModal(){
  var s=parseFloat(localStorage.getItem('studyTargetHrs')||'6');
  _st=s;
  document.querySelectorAll('#_to [data-h]').forEach(function(e){
    var h=parseFloat(e.getAttribute('data-h'));
    e.style.background=h===s?'#fef3c7':'#f1f5f9';
    e.style.border=h===s?'1.5px solid #d97706':'1.5px solid #cbd5e1';
  });
  var m=document.getElementById('_tm');
  m.style.display='flex';
}
function closeTgtModal(){document.getElementById('_tm').style.display='none';}
function pickTgt(h){
  _st=h;
  document.querySelectorAll('#_to [data-h]').forEach(function(e){
    var dh=parseFloat(e.getAttribute('data-h'));
    e.style.background=dh===h?'#fef3c7':'#f1f5f9';
    e.style.border=dh===h?'1.5px solid #d97706':'1.5px solid #cbd5e1';
  });
}
async function saveTgt(){
  localStorage.setItem('studyTargetHrs',_st);
  if(currentUser){try{await db.collection('users').doc(currentUser.uid).collection('settings').doc('studytarget').set({hours:_st});}catch(e){}}
  closeTgtModal();updTgt();showToast('Target: '+_st+' hrs/day');
}
async function logTgt(s,h){
  var t=toLocalDate(new Date());
  var k='studyTime_'+t;
  var d=JSON.parse(localStorage.getItem(k)||'{}');
  d[s]=(d[s]||0)+h;
  localStorage.setItem(k,JSON.stringify(d));
  if(currentUser){try{await db.collection('users').doc(currentUser.uid).collection('studytime').doc(t).set(d);}catch(e){}}
  updTgt();showToast('+'+(h>=1?h+'hr':(h*60)+'min')+' '+s);
}
function updTgt(){
  var tg=parseFloat(localStorage.getItem('studyTargetHrs')||'6');
  var t=toLocalDate(new Date());
  var d=JSON.parse(localStorage.getItem('studyTime_'+t)||'{}');
  var c=Object.values(d).reduce(function(a,b){return a+b;},0);
  var p=Math.min((c/tg)*100,100);
  var ce=document.getElementById('tgtCur');if(!ce)return;
  ce.textContent=c.toFixed(1);
  document.getElementById('tgtGoal').textContent=tg;
  var bar=document.getElementById('tgtBar');
  var msg=document.getElementById('tgtMsg');
  bar.style.width=p+'%';
  if(c>=tg){bar.style.background='linear-gradient(90deg,#16a34a,#22c55e)';msg.textContent='Target complete!';msg.style.color='#16a34a';}
  else{bar.style.background='linear-gradient(90deg,#d97706,#f59e0b)';msg.textContent=(tg-c).toFixed(1)+' hours remaining';msg.style.color='var(--text-dim)';}
}
(function(){var o=renderDashboard;renderDashboard=function(){o&&o.apply(this,arguments);updTgt();};})();

// --- Google OAuth Calendar ---
var GCID='183173939785-7lkinaegb39cq4jfhq724irmrrt9jakf.apps.googleusercontent.com';
var GCSC='https://www.googleapis.com/auth/calendar.events';
var _gct=null,_gcc=null,_gcEntry=null,_gcRevs=null;

window.addEventListener('load',function(){
  setTimeout(function(){
    if(typeof google!=='undefined'&&google.accounts){
      _gcc=google.accounts.oauth2.initTokenClient({
        client_id:GCID,scope:GCSC,
        callback:function(r){
          if(r.error){showToast('Calendar connect failed.');return;}
          _gct=r.access_token;
          localStorage.setItem('_gct',r.access_token);
          localStorage.setItem('_gce',Date.now()+(r.expires_in*1000));
          fetch('https://www.googleapis.com/oauth2/v3/userinfo',{headers:{'Authorization':'Bearer '+r.access_token}})
            .then(function(x){return x.json();})
            .then(function(d){_gcON(d.email||'Google Calendar');})
            .catch(function(){_gcON('Google Calendar');});
        }
      });
      var t=localStorage.getItem('_gct');
      var e=parseInt(localStorage.getItem('_gce')||'0');
      if(t&&e>Date.now()){_gct=t;_gcON(localStorage.getItem('_gcem')||'Google Calendar');}
    }
  },800);
});

function _gcON(email){
  localStorage.setItem('_gcem',email);
  var c=document.getElementById('gcalConnectSection');
  var s=document.getElementById('gcalSyncSection');
  var el=document.getElementById('gcalEmail');
  if(c)c.style.display='none';
  if(s)s.style.display='block';
  if(el)el.textContent=email+' connected';
}
// Legacy Google Calendar sync logic removed.
// The new Standalone Calendar PWA handles all visualization automatically via Firestore.

// ===================== END NEW FEATURES =====================

// ===================== TOOLS TAB FEATURES =====================

// ---- Update switchTab to handle new tabs ----
(function(){
  var origSwitch = switchTab;
  switchTab = function(name){
    document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
    document.getElementById('page-'+name).classList.add('active');
    ['add','today','dash','log','tools','backup'].forEach((n,i)=>{
      if(n===name) document.querySelectorAll('.tab')[i].classList.add('active');
    });
    var navEl = document.getElementById('nav-'+name);
    if(navEl) navEl.classList.add('active');
    if(name==='today')  renderToday();
    if(name==='log')    renderLog();
    if(name==='dash')   renderDashboard();
    if(name==='backup') updateLastBackupInfo();
    if(name==='tools')  initToolsTab();
  };
})();

function initToolsTab(){
  renderTimeTracker();
  renderMistakes();
  renderMocks();
  renderGoalStreak();
  showFormulas('Physics');
}

// =================== 1. TIME TRACKER ===================
function getTodayTimeData(){
  var t = toLocalDate(new Date());
  return JSON.parse(localStorage.getItem('studyTime_'+t)||'{}');
}
function addTime(subj, hrs){
  var t = toLocalDate(new Date());
  var k = 'studyTime_'+t;
  var d = JSON.parse(localStorage.getItem(k)||'{}');
  d[subj] = (d[subj]||0) + hrs;
  localStorage.setItem(k, JSON.stringify(d));
  if(typeof logTgt==='function') logTgt(subj, hrs);
  renderTimeTracker();
  renderGoalStreak();
  showToast('+'+(hrs>=1?hrs+'h':(hrs*60)+'min')+' '+subj);
}
function resetTodayTime(){
  if(!confirm('Reset today\'s time log?')) return;
  var t = toLocalDate(new Date());
  localStorage.removeItem('studyTime_'+t);
  renderTimeTracker();
  renderGoalStreak();
}
function renderTimeTracker(){
  var d = getTodayTimeData();
  var p = document.getElementById('tt-phy');
  var c = document.getElementById('tt-chem');
  var m = document.getElementById('tt-math');
  if(p) p.textContent = (d['Physics']||0).toFixed(1)+'h';
  if(c) c.textContent = (d['Chemistry']||0).toFixed(1)+'h';
  if(m) m.textContent = (d['Maths']||0).toFixed(1)+'h';
  renderWeekChart();
}
function renderWeekChart(){
  var canvas = document.getElementById('timeChart');
  if(!canvas) return;
  var ctx = canvas.getContext('2d');
  var days = [];
  for(var i=6;i>=0;i--){
    var d2 = new Date(); d2.setDate(d2.getDate()-i);
    var key = toLocalDate(d2);
    var data = JSON.parse(localStorage.getItem('studyTime_'+key)||'{}');
    var total = (data['Physics']||0)+(data['Chemistry']||0)+(data['Maths']||0);
    days.push({label:d2.toLocaleDateString('en-IN',{weekday:'short'}), phy:data['Physics']||0, chem:data['Chemistry']||0, math:data['Maths']||0, total:total});
  }
  canvas.width = canvas.offsetWidth * window.devicePixelRatio || 300;
  canvas.height = 80 * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio||1, window.devicePixelRatio||1);
  var W = canvas.offsetWidth||300, H=80;
  ctx.clearRect(0,0,W,H);
  var maxH = Math.max(...days.map(d=>d.total), 1);
  var barW = (W-40)/7*0.5;
  var gap  = (W-40)/7;
  days.forEach(function(d,i){
    var x = 20 + i*gap;
    var bH = (d.phy/maxH)*(H-20);
    var bH2 = (d.chem/maxH)*(H-20);
    var bH3 = (d.math/maxH)*(H-20);
    var y = H-14;
    ctx.fillStyle='#3d9bef'; ctx.fillRect(x-barW/2, y-bH, barW, bH);
    ctx.fillStyle='#22c55e'; ctx.fillRect(x-barW/2, y-bH-bH2, barW, bH2);
    ctx.fillStyle='#f59e0b'; ctx.fillRect(x-barW/2, y-bH-bH2-bH3, barW, bH3);
    ctx.fillStyle='#94a3b8'; ctx.font='9px Inter,sans-serif'; ctx.textAlign='center';
    ctx.fillText(d.label, x, H-2);
  });
}

// =================== 2. MISTAKE NOTEBOOK ===================
var _mistakes = JSON.parse(localStorage.getItem('jee_mistakes')||'[]');
var _mFilter = 'all';
function openMistakeForm(){ document.getElementById('mistakeModal').classList.add('show'); }
function closeMistakeForm(){ document.getElementById('mistakeModal').classList.remove('show'); }
function saveMistake(){
  var subj = document.getElementById('mSubject').value;
  var type = document.getElementById('mType').value;
  var topic = document.getElementById('mTopic').value.trim();
  var q = document.getElementById('mQuestion').value.trim();
  var note = document.getElementById('mNote').value.trim();
  if(!topic){ showToast('Enter a topic/chapter!'); return; }
  _mistakes.unshift({id:Date.now(), subj, type, topic, q, note, date:toLocalDate(new Date())});
  localStorage.setItem('jee_mistakes', JSON.stringify(_mistakes));
  closeMistakeForm();
  document.getElementById('mTopic').value='';
  document.getElementById('mQuestion').value='';
  document.getElementById('mNote').value='';
  renderMistakes();
  showToast('Mistake logged!');
}
function filterMistakes(f){
  _mFilter=f;
  ['all','Physics','Chemistry','Maths'].forEach(function(s){
    var id='mf-'+(s==='all'?'all':s==='Physics'?'phy':s==='Chemistry'?'chem':'math');
    var el=document.getElementById(id); if(!el) return;
    el.style.background = s===f?'var(--teal)':'var(--surface2)';
    el.style.color = s===f?'#fff':'var(--text-muted)';
    el.style.border = s===f?'none':'1px solid var(--border)';
  });
  renderMistakes();
}
function deleteMistake(id){
  _mistakes = _mistakes.filter(function(m){return m.id!==id;});
  localStorage.setItem('jee_mistakes', JSON.stringify(_mistakes));
  renderMistakes();
}
function renderMistakes(){
  var list = document.getElementById('mistakeList'); if(!list) return;
  var filtered = _mFilter==='all' ? _mistakes : _mistakes.filter(function(m){return m.subj===_mFilter;});
  if(!filtered.length){ list.innerHTML='<div class="empty-state"><span class="emoji">📕</span><p>No mistakes logged yet.<br>Every mistake is a step forward!</p></div>'; return; }
  var colors={Physics:'#3d9bef',Chemistry:'#22c55e',Maths:'#f59e0b'};
  list.innerHTML = filtered.map(function(m){
    return '<div class="mistake-item">'+
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">'+
        '<span style="background:'+colors[m.subj]+'22;color:'+colors[m.subj]+';border:1px solid '+colors[m.subj]+'44;border-radius:5px;padding:1px 7px;font-size:0.55rem;font-weight:700;">'+m.subj+'</span>'+
        '<span style="background:#fee2e2;color:#dc2626;border-radius:5px;padding:1px 7px;font-size:0.55rem;font-weight:700;">'+m.type+'</span>'+
        '<span style="margin-left:auto;font-size:0.55rem;color:var(--text-dim);">'+m.date+'</span>'+
        '<button onclick="deleteMistake('+m.id+')" style="background:none;border:none;font-size:0.75rem;cursor:pointer;color:var(--text-dim);padding:0 2px;">✕</button>'+
      '</div>'+
      '<div class="mistake-topic">'+m.topic+(m.q?': '+m.q:'')+'</div>'+
      (m.note?'<div class="mistake-reason">💡 '+m.note+'</div>':'')+
    '</div>';
  }).join('');
}

// =================== 3. MOCK TEST TRACKER ===================
var _mocks = JSON.parse(localStorage.getItem('jee_mocks')||'[]');
function openMockForm(){ document.getElementById('mockModal').classList.add('show'); }
function closeMockForm(){ document.getElementById('mockModal').classList.remove('show'); }
function saveMock(){
  var name = document.getElementById('mockName').value.trim()||'Mock Test';
  var total = parseFloat(document.getElementById('mockTotal').value)||0;
  var max = parseFloat(document.getElementById('mockMax').value)||300;
  var phy = parseFloat(document.getElementById('mockPhy').value)||0;
  var chem = parseFloat(document.getElementById('mockChem').value)||0;
  var math = parseFloat(document.getElementById('mockMath').value)||0;
  var note = document.getElementById('mockNote').value.trim();
  _mocks.push({id:Date.now(), name, total, max, phy, chem, math, note, date:toLocalDate(new Date())});
  localStorage.setItem('jee_mocks', JSON.stringify(_mocks));
  closeMockForm();
  ['mockName','mockTotal','mockMax','mockPhy','mockChem','mockMath','mockNote'].forEach(function(id){ var el=document.getElementById(id); if(el){ el.value=id==='mockMax'?'300':'';} });
  renderMocks();
  showToast('Mock test saved!');
}
function deleteMock(id){
  _mocks = _mocks.filter(function(m){return m.id!==id;});
  localStorage.setItem('jee_mocks', JSON.stringify(_mocks));
  renderMocks();
}
function renderMocks(){
  var list = document.getElementById('mockList'); if(!list) return;
  if(!_mocks.length){ list.innerHTML='<div class="empty-state"><span class="emoji">📝</span><p>No mock tests logged yet.</p></div>'; renderMockChart(); return; }
  list.innerHTML = _mocks.slice().reverse().map(function(m){
    var pct = Math.round(m.total/m.max*100);
    var col = pct>=70?'#22c55e':pct>=50?'#f59e0b':'#dc2626';
    return '<div class="mock-item">'+
      '<div class="mock-score" style="color:'+col+'">'+m.total+'<span style="font-size:0.55rem;color:var(--text-dim);">/'+m.max+'</span></div>'+
      '<div class="mock-detail">'+
        '<div style="font-size:0.78rem;font-weight:600;color:var(--text);">'+m.name+'</div>'+
        '<div>⚡'+m.phy+' 🧪'+m.chem+' 📐'+m.math+' · '+m.date+'</div>'+
        (m.note?'<div style="color:var(--text-dim);font-size:0.62rem;">'+m.note+'</div>':'')+
      '</div>'+
      '<span class="mock-badge" style="background:'+col+'22;color:'+col+';border:1px solid '+col+'44;">'+pct+'%</span>'+
      '<button onclick="deleteMock('+m.id+')" style="background:none;border:none;font-size:0.75rem;cursor:pointer;color:var(--text-dim);">✕</button>'+
    '</div>';
  }).join('');
  renderMockChart();
}
function renderMockChart(){
  var el = document.getElementById('mockScoreChart'); if(!el) return;
  if(_mocks.length<2){ el.innerHTML=''; return; }
  var last8 = _mocks.slice(-8);
  var maxScore = Math.max(...last8.map(function(m){return m.max;}))||300;
  var barH = 50;
  var bars = last8.map(function(m,i){
    var h = Math.round((m.total/m.max)*barH);
    var pct = Math.round(m.total/m.max*100);
    var col = pct>=70?'#22c55e':pct>=50?'#f59e0b':'#dc2626';
    return '<div style="display:flex;flex-direction:column;align-items:center;flex:1;gap:3px;">'+
      '<div style="font-size:0.6rem;font-weight:700;color:'+col+'">'+pct+'%</div>'+
      '<div style="width:100%;height:'+barH+'px;display:flex;align-items:flex-end;justify-content:center;">'+
        '<div style="width:70%;background:'+col+';border-radius:4px 4px 0 0;height:'+Math.max(h,2)+'px;transition:height 0.4s;"></div>'+
      '</div>'+
      '<div style="font-size:0.48rem;color:var(--text-dim);text-align:center;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+(m.name.length>8?m.name.slice(0,8)+'…':m.name)+'</div>'+
    '</div>';
  }).join('');
  el.innerHTML='<div style="display:flex;gap:4px;align-items:flex-end;padding:4px 0;">'+bars+'</div>';
}

// =================== 4. POMODORO ===================
var _pomoTimer=null, _pomoLeft=25*60, _pomoTotal=25*60, _pomoRunning=false, _pomoSessions=0;
function setPomoMode(mins, label){
  resetPomo();
  _pomoTotal = _pomoLeft = mins*60;
  document.getElementById('pomoLabel').textContent = label;
  ['pomo-25','pomo-50','pomo-5'].forEach(function(id){ var el=document.getElementById(id); if(el){el.style.background='var(--surface2)';el.style.color='var(--text-muted)';el.style.border='1px solid var(--border)';el.style.borderColor='var(--border)';}});
  var activeId = mins===25?'pomo-25':mins===50?'pomo-50':'pomo-5';
  var active = document.getElementById(activeId); if(active){active.style.background='var(--teal)';active.style.color='#fff';active.style.border='none';}
  updatePomoDisplay();
}
function updatePomoDisplay(){
  var m=Math.floor(_pomoLeft/60), s=_pomoLeft%60;
  var timeEl=document.getElementById('pomoTime'); if(timeEl) timeEl.textContent=(m<10?'0':'')+m+':'+(s<10?'0':'')+s;
  var circ=document.getElementById('pomoCircle'); if(circ){var pct=_pomoLeft/_pomoTotal;circ.style.strokeDashoffset=377*(1-pct);}
}
function startPomo(){
  if(_pomoRunning){
    clearInterval(_pomoTimer); _pomoRunning=false;
    document.getElementById('pomoStartBtn').textContent='▶ Start';
    return;
  }
  _pomoRunning=true;
  document.getElementById('pomoStartBtn').textContent='⏸ Pause';
  _pomoTimer=setInterval(function(){
    if(_pomoLeft<=0){
      clearInterval(_pomoTimer); _pomoRunning=false;
      document.getElementById('pomoStartBtn').textContent='▶ Start';
      _pomoSessions++;
      var sesEl=document.getElementById('pomoSessions'); if(sesEl) sesEl.textContent=_pomoSessions+' sessions today';
      var subj=document.getElementById('pomoSubject').value;
      var mins=_pomoTotal/60;
      if(mins>4) addTime(subj, mins/60);
      showToast('🍅 Session complete! +'+Math.round(mins)+'min logged');
      return;
    }
    _pomoLeft--;
    updatePomoDisplay();
  },1000);
}
function resetPomo(){
  clearInterval(_pomoTimer); _pomoRunning=false;
  _pomoLeft=_pomoTotal;
  var btn=document.getElementById('pomoStartBtn'); if(btn) btn.textContent='▶ Start';
  updatePomoDisplay();
}

// =================== 5. QUESTION TRACKER ===================
function getQData(){
  var t=toLocalDate(new Date());
  return JSON.parse(localStorage.getItem('jee_q_'+t)||'{}');
}
function addQ(subj,n){
  var t=toLocalDate(new Date());
  var k='jee_q_'+t;
  var d=JSON.parse(localStorage.getItem(k)||'{}');
  d[subj]=(d[subj]||0)+n;
  localStorage.setItem(k,JSON.stringify(d));
  renderQ();
  showToast('+'+n+' '+subj+' questions');
}
function renderQ(){
  var d=getQData();
  var phy=d['Physics']||0,chem=d['Chemistry']||0,math=d['Maths']||0;
  var ep=document.getElementById('qa-phy'),ec=document.getElementById('qa-chem'),em=document.getElementById('qa-math'),et=document.getElementById('qa-total');
  if(ep)ep.textContent=phy; if(ec)ec.textContent=chem; if(em)em.textContent=math;
  if(et)et.textContent=phy+chem+math;
}

// =================== 6. FORMULA QUICK-REF ===================
var FORMULAS = {
  Physics:[
    {section:'Kinematics',items:[
      {name:'Displacement',eq:'s = ut + ½at²',note:'u=initial vel, a=acceleration, t=time'},
      {name:'Velocity',eq:'v = u + at',note:'v=final velocity'},
      {name:'v²-u² relation',eq:'v² = u² + 2as',note:'Useful when time unknown'},
      {name:'Average velocity',eq:'v_avg = (u+v)/2',note:'Only for uniform acceleration'},
    ]},
    {section:'Laws of Motion',items:[
      {name:'Newton 2nd Law',eq:'F = ma',note:'Net force = mass × acceleration'},
      {name:'Momentum',eq:'p = mv',note:'m=mass, v=velocity'},
      {name:'Impulse',eq:'J = FΔt = Δp',note:'Change in momentum'},
      {name:'Friction',eq:'f = μN',note:'μ=coefficient, N=normal force'},
    ]},
    {section:'Energy & Work',items:[
      {name:'Work done',eq:'W = F·d·cosθ',note:'θ=angle between F and d'},
      {name:'Kinetic energy',eq:'KE = ½mv²',note:''},
      {name:'Potential energy',eq:'PE = mgh',note:'Near Earth surface'},
      {name:'Power',eq:'P = W/t = Fv',note:''},
    ]},
    {section:'Gravitation',items:[
      {name:'Gravitational force',eq:'F = Gm₁m₂/r²',note:'G = 6.67×10⁻¹¹'},
      {name:'Orbital velocity',eq:'v = √(GM/r)',note:'For circular orbit'},
      {name:'Escape velocity',eq:'v_e = √(2GM/R)',note:'= √2 × orbital velocity'},
    ]},
    {section:'Waves & SHM',items:[
      {name:'Time period SHM',eq:'T = 2π√(m/k)',note:'k=spring constant'},
      {name:'Wave speed',eq:'v = fλ',note:'f=frequency, λ=wavelength'},
      {name:'Pendulum',eq:'T = 2π√(L/g)',note:'L=length, g=9.8 m/s²'},
    ]},
    {section:'Electrostatics',items:[
      {name:'Coulomb\'s law',eq:'F = kq₁q₂/r²',note:'k = 9×10⁹ Nm²/C²'},
      {name:'Electric field',eq:'E = F/q = kQ/r²',note:''},
      {name:'Potential',eq:'V = kQ/r',note:''},
      {name:'Capacitance',eq:'C = Q/V = ε₀A/d',note:'Parallel plate'},
    ]},
    {section:'Current Electricity',items:[
      {name:'Ohm\'s law',eq:'V = IR',note:''},
      {name:'Power',eq:'P = VI = I²R = V²/R',note:''},
      {name:'Series R',eq:'R = R₁+R₂+R₃',note:''},
      {name:'Parallel R',eq:'1/R = 1/R₁+1/R₂',note:''},
    ]},
  ],
  Chemistry:[
    {section:'Mole Concept',items:[
      {name:'Moles',eq:'n = m/M',note:'m=mass(g), M=molar mass'},
      {name:'Avogadro',eq:'N = n × Nₐ',note:'Nₐ = 6.022×10²³'},
      {name:'Ideal gas',eq:'PV = nRT',note:'R = 8.314 J/mol·K'},
      {name:'Molarity',eq:'M = n/V(L)',note:'moles per litre'},
    ]},
    {section:'Thermodynamics',items:[
      {name:'1st law',eq:'ΔU = q + w',note:'q=heat, w=work done on system'},
      {name:'Enthalpy',eq:'ΔH = ΔU + ΔngRT',note:'Δng = moles gas products - reactants'},
      {name:'Gibbs energy',eq:'ΔG = ΔH - TΔS',note:'ΔG<0 → spontaneous'},
      {name:'Entropy',eq:'ΔS = q_rev/T',note:''},
    ]},
    {section:'Equilibrium',items:[
      {name:'Kc expression',eq:'Kc = [products]/[reactants]',note:'Molar concentrations'},
      {name:'Kp-Kc relation',eq:'Kp = Kc(RT)^Δn',note:'Δn = change in moles of gas'},
      {name:'pH',eq:'pH = -log[H⁺]',note:''},
      {name:'Henderson-H.',eq:'pH = pKa + log([A⁻]/[HA])',note:'Buffer solution'},
    ]},
    {section:'Electrochemistry',items:[
      {name:'Nernst equation',eq:'E = E° - (RT/nF)lnQ',note:'at 25°C: E = E° - (0.059/n)logQ'},
      {name:'Faraday\'s law',eq:'m = MIt/nF',note:'F = 96500 C/mol'},
      {name:'Gibbs-EMF',eq:'ΔG° = -nFE°',note:''},
    ]},
    {section:'Kinetics',items:[
      {name:'Rate law',eq:'r = k[A]^m[B]^n',note:'m,n = orders'},
      {name:'1st order',eq:'ln[A] = ln[A₀] - kt',note:'t₁/₂ = 0.693/k'},
      {name:'Arrhenius',eq:'k = Ae^(-Ea/RT)',note:'Ea=activation energy'},
    ]},
  ],
  Maths:[
    {section:'Quadratic',items:[
      {name:'Quadratic formula',eq:'x = (-b ± √(b²-4ac)) / 2a',note:'For ax²+bx+c=0'},
      {name:'Sum of roots',eq:'α+β = -b/a',note:''},
      {name:'Product of roots',eq:'αβ = c/a',note:''},
      {name:'Discriminant',eq:'D = b²-4ac',note:'D>0 real distinct, D=0 equal, D<0 complex'},
    ]},
    {section:'Trigonometry',items:[
      {name:'Pythagorean',eq:'sin²θ + cos²θ = 1',note:'Also: sec²=1+tan², cosec²=1+cot²'},
      {name:'Double angle',eq:'sin2θ = 2sinθcosθ',note:'cos2θ = cos²θ-sin²θ = 1-2sin²θ'},
      {name:'Sum formula',eq:'sin(A±B) = sinAcosB ± cosAsinB',note:''},
      {name:'cos sum',eq:'cos(A±B) = cosAcosB ∓ sinAsinB',note:''},
    ]},
    {section:'Calculus',items:[
      {name:'Chain rule',eq:'d/dx[f(g(x))] = f\'(g(x))·g\'(x)',note:''},
      {name:'Product rule',eq:'d/dx[uv] = u\'v + uv\'',note:''},
      {name:'Integration by parts',eq:'∫u dv = uv - ∫v du',note:'LIATE order for u'},
      {name:'Definite integral',eq:'∫ₐᵇ f(x)dx = F(b)-F(a)',note:'F is antiderivative'},
    ]},
    {section:'Coordinate Geometry',items:[
      {name:'Distance formula',eq:'d = √((x₂-x₁)²+(y₂-y₁)²)',note:''},
      {name:'Section formula',eq:'(mx₂+nx₁)/(m+n), (my₂+ny₁)/(m+n)',note:'Divides in m:n'},
      {name:'Circle',eq:'(x-h)²+(y-k)² = r²',note:'Centre (h,k), radius r'},
      {name:'Parabola',eq:'y² = 4ax',note:'Focus (a,0), directrix x=-a'},
    ]},
    {section:'Vectors & 3D',items:[
      {name:'Dot product',eq:'a·b = |a||b|cosθ',note:''},
      {name:'Cross product',eq:'|a×b| = |a||b|sinθ',note:'Direction: right-hand rule'},
      {name:'Distance point-plane',eq:'d = |ax₁+by₁+cz₁+d|/√(a²+b²+c²)',note:''},
    ]},
    {section:'Sequences',items:[
      {name:'AP nth term',eq:'aₙ = a + (n-1)d',note:''},
      {name:'AP sum',eq:'Sₙ = n/2[2a+(n-1)d]',note:''},
      {name:'GP nth term',eq:'aₙ = arⁿ⁻¹',note:''},
      {name:'GP sum',eq:'Sₙ = a(rⁿ-1)/(r-1)',note:'r≠1'},
    ]},
  ]
};

var _curSubj = 'Physics';
function showFormulas(subj){
  _curSubj = subj;
  ['Physics','Chemistry','Maths'].forEach(function(s){
    var id='ff-'+(s==='Physics'?'phy':s==='Chemistry'?'chem':'math');
    var el=document.getElementById(id); if(!el) return;
    if(s===subj){el.style.background='var(--teal)';el.style.color='#fff';el.style.border='none';}
    else{el.style.background='var(--surface2)';el.style.color='var(--text-muted)';el.style.border='1px solid var(--border)';}
  });
  var list=document.getElementById('formulaList'); if(!list) return;
  var sections=FORMULAS[subj]||[];
  list.innerHTML=sections.map(function(sec){
    return '<div class="formula-section">'+
      '<div class="formula-section-title" onclick="this.parentElement.classList.toggle(\'collapsed\')">'+sec.section+'</div>'+
      '<div class="formula-items">'+
        sec.items.map(function(f){
          return '<div class="formula-card">'+
            '<div class="formula-name">'+f.name+'</div>'+
            '<div class="formula-eq">'+f.eq+'</div>'+
            (f.note?'<div class="formula-note">'+f.note+'</div>':'')+
          '</div>';
        }).join('')+
      '</div>'+
    '</div>';
  }).join('');
}

// =================== 7. BUS FLASHCARDS ===================
var FLASHCARDS = {
  Physics:[
    {q:'State Newton\'s 3rd law',a:'Every action has an equal and opposite reaction.'},
    {q:'What is SHM?',a:'Simple Harmonic Motion: acceleration ∝ -displacement. a = -ω²x'},
    {q:'Formula for escape velocity',a:'v_e = √(2gR) ≈ 11.2 km/s for Earth'},
    {q:'What is Ohm\'s law?',a:'V = IR. At constant temp, current is proportional to voltage.'},
    {q:'Kirchhoff\'s Current Law',a:'Sum of currents entering a junction = sum leaving. ΣI = 0'},
    {q:'What is total internal reflection?',a:'When light goes from denser to rarer medium at angle > critical angle.'},
    {q:'Formula for kinetic energy',a:'KE = ½mv². Unit: Joule (J)'},
    {q:'What is Bernoulli\'s principle?',a:'P + ½ρv² + ρgh = constant (energy conservation for fluids)'},
    {q:'Lenz\'s law',a:'Induced current opposes the change in magnetic flux that causes it.'},
    {q:'de Broglie wavelength',a:'λ = h/mv = h/p. Even particles have wave nature.'},
  ],
  Chemistry:[
    {q:'State Hund\'s rule',a:'Electrons occupy orbitals singly with same spin before pairing.'},
    {q:'What is hybridization of CH₄?',a:'sp³ hybridization. Tetrahedral shape, 109.5° bond angle.'},
    {q:'Define Le Chatelier\'s principle',a:'A system at equilibrium shifts to counteract any imposed stress.'},
    {q:'What is Faraday\'s 1st law?',a:'Mass deposited ∝ quantity of electricity passed. m = ZIt'},
    {q:'Half-life of 1st order reaction',a:'t₁/₂ = 0.693/k (independent of initial concentration)'},
    {q:'What is Kohlrausch\'s law?',a:'Λ°m = Σλ° (ions). Molar conductance at infinite dilution = sum of ion conductances.'},
    {q:'VSEPR theory predicts...',a:'Shape of molecules based on electron pair repulsions.'},
    {q:'What is Raoult\'s law?',a:'P_solution = x_solvent × P°_solvent. Partial pressure = mole fraction × vapour pressure of pure.'},
    {q:'Define molality',a:'m = moles of solute / kg of solvent (not volume!)'},
    {q:'Buffer solution maintains...',a:'Nearly constant pH on addition of small amounts of acid or base.'},
  ],
  Maths:[
    {q:'Derivative of sin(x)',a:'cos(x)'},
    {q:'Derivative of ln(x)',a:'1/x'},
    {q:'∫ eˣ dx',a:'eˣ + C'},
    {q:'∫ 1/x dx',a:'ln|x| + C'},
    {q:'Sum of first n natural numbers',a:'n(n+1)/2'},
    {q:'Sum of squares of first n naturals',a:'n(n+1)(2n+1)/6'},
    {q:'Value of ⁿCᵣ formula',a:'n! / (r!(n-r)!)'},
    {q:'Angle between lines with slopes m₁, m₂',a:'tanθ = |m₁-m₂| / (1+m₁m₂)'},
    {q:'Area of triangle with vertices',a:'½|x₁(y₂-y₃) + x₂(y₃-y₁) + x₃(y₁-y₂)|'},
    {q:'Bayes\' theorem statement',a:'P(A|B) = P(B|A)·P(A) / P(B)'},
  ]
};

var _flashCards=[], _flashIdx=0, _flashFlipped=false;
function startFlash(subj){
  _flashCards = FLASHCARDS[subj].slice().sort(function(){return Math.random()-0.5;});
  _flashIdx=0; _flashFlipped=false;
  document.getElementById('flashEmpty').style.display='none';
  document.getElementById('flashCard').style.display='block';
  document.getElementById('flashNav').style.display='block';
  showFlashCard();
}
function showFlashCard(){
  _flashFlipped=false;
  var f=document.getElementById('flashFront'), b=document.getElementById('flashBack');
  if(f) f.style.display='block'; if(b) b.style.display='none';
  var q=document.getElementById('flashQ'); if(q) q.textContent=_flashCards[_flashIdx].q;
  var cnt=document.getElementById('flashCount'); if(cnt) cnt.textContent=(_flashIdx+1)+'/'+_flashCards.length;
  document.getElementById('flashCard').style.background='linear-gradient(135deg,var(--teal-dim),var(--teal))';
}
function flipFlash(){
  _flashFlipped=!_flashFlipped;
  var f=document.getElementById('flashFront'), b=document.getElementById('flashBack');
  if(f) f.style.display=_flashFlipped?'none':'block';
  if(b) b.style.display=_flashFlipped?'block':'none';
  if(_flashFlipped){ var a=document.getElementById('flashA'); if(a) a.textContent=_flashCards[_flashIdx].a; document.getElementById('flashCard').style.background='linear-gradient(135deg,#166534,#16a34a)'; }
  else document.getElementById('flashCard').style.background='linear-gradient(135deg,var(--teal-dim),var(--teal))';
}
function nextFlash(){ _flashIdx=(_flashIdx+1)%_flashCards.length; showFlashCard(); }
function prevFlash(){ _flashIdx=(_flashIdx-1+_flashCards.length)%_flashCards.length; showFlashCard(); }

// =================== 8. GOAL STREAK ===================
function renderGoalStreak(){
  var tg=parseFloat(localStorage.getItem('studyTargetHrs')||'6');
  var goalEl=document.getElementById('goalTarget'); if(goalEl) goalEl.textContent=tg+'h';
  var streak=0, best=0, cur=0;
  for(var i=0;i<60;i++){
    var d2=new Date(); d2.setDate(d2.getDate()-i);
    var key=toLocalDate(d2);
    var data=JSON.parse(localStorage.getItem('studyTime_'+key)||'{}');
    var total=Object.values(data).reduce(function(a,b){return a+b;},0);
    if(total>=tg){ cur++; if(cur>best) best=cur; }
    else if(i>0) break;
    if(i===0 && total<tg) cur=0;
  }
  streak=cur;
  var gs=document.getElementById('goalStreak'); if(gs) gs.textContent=streak;
  var gb=document.getElementById('goalBest'); if(gb) gb.textContent=best;
  var gm=document.getElementById('goalMsg'); if(gm){
    var today=JSON.parse(localStorage.getItem('studyTime_'+toLocalDate(new Date()))||'{}');
    var todayH=Object.values(today).reduce(function(a,b){return a+b;},0);
    if(todayH>=tg) gm.innerHTML='✅ Goal reached today! Streak active 🔥';
    else gm.innerHTML='📖 Study '+(tg-todayH).toFixed(1)+'h more to keep your streak!';
  }
}

// =================== INIT ===================
document.addEventListener('DOMContentLoaded', function(){
  renderQ();
  updatePomoDisplay();
  showFormulas('Physics');
});

// Close modals on overlay click
document.getElementById('mistakeModal').addEventListener('click', function(e){ if(e.target===this) closeMistakeForm(); });
document.getElementById('mockModal').addEventListener('click', function(e){ if(e.target===this) closeMockForm(); });


// ===================== FEATURE: SMART REVISION =====================
// Replaces simple checkbox with Easy / Normal / Hard rating buttons
// Hard → schedules a repeat revision for tomorrow automatically

function getRatings(){
  return JSON.parse(localStorage.getItem('ebbing_ratings')||'{}');
}
function saveRatings(r){ localStorage.setItem('ebbing_ratings', JSON.stringify(r)); }

function rateRevision(key, rating){
  // 1. Mark done
  const today = toLocalDate(new Date());
  const sk = 'ebbing_done_'+today;
  const set = new Set(JSON.parse(localStorage.getItem(sk)||'[]'));
  set.add(key); localStorage.setItem(sk, JSON.stringify([...set]));
  // 2. Store rating
  const ratings = getRatings(); ratings[key] = rating; saveRatings(ratings);
  // 3. If Hard → schedule a bonus repeat for tomorrow
  if(rating === 'hard'){
    const tmr = new Date(); tmr.setDate(tmr.getDate()+1);
    const tmrStr = toLocalDate(tmr);
    const hardKey = 'ebbing_hard_'+tmrStr;
    const existing = JSON.parse(localStorage.getItem(hardKey)||'[]');
    // Find topic name from key (format: entryId_label)
    const entryId = key.split('_')[0];
    const entry = entries.find(e=>String(e.id)===entryId);
    if(entry && !existing.find(x=>x.key===key)){
      existing.push({topic: entry.topic, label: 'Repeat', key, origKey: key});
      localStorage.setItem(hardKey, JSON.stringify(existing));
    }
  }
  renderToday(); updateTodayBadge();
  const msgs = {easy:'✅ Easy! Great work!', normal:'✔ Marked done!', hard:'🔁 Scheduled repeat for tomorrow!'};
  showToast(msgs[rating]||'Done!');
}

// Override getTodayItems to include hard-repeat items
(function(){
  var orig = getTodayItems;
  getTodayItems = function(){
    var items = orig();
    var today = toLocalDate(new Date());
    var hardItems = JSON.parse(localStorage.getItem('ebbing_hard_'+today)||'[]');
    var doneSet = getDoneSet();
    hardItems.forEach(function(h){
      if(!items.find(function(i){return i.key===h.key;})){
        items.push({
          topic: h.topic, label: '🔁 Repeat', datetime: new Date().toISOString(),
          key: h.key, done: doneSet.has(h.key), link: ''
        });
      }
    });
    return items;
  };
})();

// Override renderToday to show rating buttons
(function(){
  var origRender = renderToday;
  renderToday = function(){
    var items = getTodayItems();
    var c = document.getElementById('todayContent');
    var dl = new Date().toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
    if(!items.length){
      c.innerHTML='<div class="empty-state"><span class="emoji">✅</span><p>Nothing to revise today.<br><span style="font-size:0.76rem;color:var(--text-dim)">'+dl+'</span></p></div>';
      return;
    }
    var ratings = getRatings();
    var doneCount = items.filter(function(i){return i.done;}).length;
    var itemsHtml = items.map(function(item){
      var rating = ratings[item.key];
      var doneStyle = item.done ? 'opacity:0.55;' : '';
      var ratingBadge = rating==='easy'?'<span style="background:#dcfce7;color:#16a34a;border-radius:5px;padding:1px 7px;font-size:0.55rem;font-weight:700;margin-left:4px;">Easy</span>':
                         rating==='hard'?'<span style="background:#fee2e2;color:#dc2626;border-radius:5px;padding:1px 7px;font-size:0.55rem;font-weight:700;margin-left:4px;">Hard</span>':'';
      if(item.done){
        return '<div class="today-item done-item" id="ti-'+item.key+'" style="'+doneStyle+'">'
          +'<span class="today-badge">'+item.label+'</span>'
          +'<span class="today-topic" style="text-decoration:line-through;opacity:0.6;">'+item.topic+'</span>'
          +ratingBadge
          +'</div>';
      }
      return '<div class="today-item" id="ti-'+item.key+'">'
        +'<span class="today-badge">'+item.label+'</span>'
        +'<span class="today-topic">'+item.topic+'</span>'
        +'<div style="display:flex;gap:4px;margin-left:auto;flex-shrink:0;">'
        +'<button onclick="rateRevision(\''+item.key+'\',\'easy\')" title="I remembered it perfectly" style="background:#dcfce7;border:none;border-radius:7px;padding:5px 8px;font-size:0.6rem;cursor:pointer;color:#16a34a;font-weight:700;white-space:nowrap;">✅ Easy</button>'
        +'<button onclick="rateRevision(\''+item.key+'\',\'normal\')" title="Normal - took some effort" style="background:var(--surface2);border:1px solid var(--border);border-radius:7px;padding:5px 8px;font-size:0.6rem;cursor:pointer;color:var(--text-muted);font-weight:700;white-space:nowrap;">✔ OK</button>'
        +'<button onclick="rateRevision(\''+item.key+'\',\'hard\')" title="Hard - repeat tomorrow" style="background:#fee2e2;border:none;border-radius:7px;padding:5px 8px;font-size:0.6rem;cursor:pointer;color:#dc2626;font-weight:700;white-space:nowrap;">🔁 Hard</button>'
        +'</div>'
        +'</div>';
    }).join('');

    c.innerHTML = '<div class="card card-green">'
      +'<div class="card-header"><div class="live-dot"></div><h3>Revise Today</h3>'
      +'<span class="meta">'+new Date().toLocaleDateString('en-IN',{day:'numeric',month:'short'})+'</span></div>'
      +'<div style="padding:2px 16px 4px;">'
      +'<div style="font-size:0.56rem;color:var(--text-dim);letter-spacing:0.1em;text-transform:uppercase;padding:8px 0 4px;border-top:1px solid var(--border);font-weight:600;">'
      +'Rate each revision — Hard items repeat tomorrow automatically</div></div>'
      +itemsHtml
      +'<div class="done-summary"><span>✅ '+doneCount+' / '+items.length+' done</span>'
      +(doneCount>0?'<button class="reset-btn" onclick="resetDone()">Reset</button>':'')
      +'</div></div>';
  };
})();
// ===================== END SMART REVISION =====================


// ===================== FEATURE: MISTAKE FLASHCARDS =====================
var _mfc = { cards:[], idx:0, flipped:false };

function buildMistakeCards(filter){
  var src = typeof _mistakes !== 'undefined' ? _mistakes : JSON.parse(localStorage.getItem('jee_mistakes')||'[]');
  var filtered = filter==='all' ? src : src.filter(function(m){return m.subj===filter;});
  // Shuffle
  _mfc.cards = filtered.slice().sort(function(){return Math.random()-0.5;});
  _mfc.idx = 0; _mfc.flipped = false;
  renderMistakeCard();
}

function renderMistakeCard(){
  var el = document.getElementById('mfcCard'); if(!el) return;
  var nav = document.getElementById('mfcNav');
  var empty = document.getElementById('mfcEmpty');
  var counter = document.getElementById('mfcCounter');
  if(!_mfc.cards.length){
    el.style.display='none'; if(nav)nav.style.display='none';
    if(empty)empty.style.display='block';
    if(counter)counter.textContent='';
    return;
  }
  el.style.display='block'; if(nav)nav.style.display='block';
  if(empty)empty.style.display='none';
  var m = _mfc.cards[_mfc.idx];
  var colors={Physics:'#3d9bef',Chemistry:'#22c55e',Maths:'#f59e0b'};
  var col = colors[m.subj]||'#0ea5e9';
  _mfc.flipped=false;
  el.style.background = 'linear-gradient(135deg,'+col+'22,'+col+'44)';
  el.style.borderColor = col+'44';
  document.getElementById('mfcFront').style.display='block';
  document.getElementById('mfcBack').style.display='none';
  document.getElementById('mfcQ').innerHTML =
    '<span style="background:'+col+'22;color:'+col+';border:1px solid '+col+'44;border-radius:6px;padding:2px 8px;font-size:0.6rem;font-weight:700;display:inline-block;margin-bottom:8px;">'+m.subj+' · '+m.type+'</span><br>'
    +'<strong style="font-size:0.95rem;">'+m.topic+'</strong>'
    +(m.q?'<br><span style="font-size:0.78rem;opacity:0.85;margin-top:6px;display:block;">'+m.q+'</span>':'');
  document.getElementById('mfcA').textContent = m.note || 'No note added.';
  if(counter) counter.textContent = (_mfc.idx+1)+' / '+_mfc.cards.length;
}

function flipMistakeFlash(){
  if(!_mfc.cards.length) return;
  _mfc.flipped = !_mfc.flipped;
  document.getElementById('mfcFront').style.display = _mfc.flipped?'none':'block';
  document.getElementById('mfcBack').style.display  = _mfc.flipped?'block':'none';
}

function nextMistakeFlash(){
  if(!_mfc.cards.length) return;
  _mfc.idx = (_mfc.idx+1) % _mfc.cards.length;
  renderMistakeCard();
}

function prevMistakeFlash(){
  if(!_mfc.cards.length) return;
  _mfc.idx = (_mfc.idx-1+_mfc.cards.length) % _mfc.cards.length;
  renderMistakeCard();
}

function setMFCFilter(f, btn){
  ['mfc-all','mfc-phy','mfc-chem','mfc-math'].forEach(function(id){
    var el=document.getElementById(id);if(!el)return;
    el.style.background='var(--surface2)';el.style.color='var(--text-muted)';el.style.border='1px solid var(--border)';
  });
  if(btn){btn.style.background='var(--teal)';btn.style.color='#fff';btn.style.border='none';}
  buildMistakeCards(f);
}

// Hook into initToolsTab
(function(){
  var origInit = typeof initToolsTab!=='undefined' ? initToolsTab : null;
  if(origInit){
    var wrap = initToolsTab;
    window.initToolsTab = function(){
      wrap();
      buildMistakeCards('all');
    };
  }
})();
// ===================== END MISTAKE FLASHCARDS =====================

// -- CALENDAR LOGIC --
let curCalDate = new Date();

function changeMonth(dir){
  curCalDate.setMonth(curCalDate.getMonth() + dir);
  renderCalendar();
}

function renderCalendar(){
  const grid = document.getElementById('calendarGrid');
  const monthYear = document.getElementById('calMonthYear');
  if(!grid || !monthYear) return;

  const year = curCalDate.getFullYear();
  const month = curCalDate.getMonth();
  const today = new Date();
  
  monthYear.textContent = curCalDate.toLocaleDateString('en-IN', {month:'long', year:'numeric'});
  
  // Calculate days
  const firstDay = new Date(year, month, 1).getDay(); // 0 (Sun) to 6 (Sat)
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();
  
  // Headers
  let html = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => `<div class="cal-day-label">${d}</div>`).join('');
  
  // Group events by date for the dots
  const eventMap = {};
  entries.forEach(e => {
    e.revisions.forEach(r => {
      const d = toLocalDate(new Date(r.datetime));
      if(!eventMap[d]) eventMap[d] = [];
      eventMap[d].push({...r, topic: e.topic});
    });
  });

  // Prev month filler
  for(let i = firstDay; i > 0; i--){
    const d = daysInPrevMonth - i + 1;
    html += `<div class="cal-date other-month">${d}</div>`;
  }
  
  // Current month days
  for(let d = 1; d <= daysInMonth; d++){
    const dateStr = `${year}-${p(month+1)}-${p(d)}`;
    const isToday = toLocalDate(today) === dateStr;
    const events = eventMap[dateStr] || [];
    
    html += `
      <div class="cal-date ${isToday?'today':''}" onclick="showDayDetails('${dateStr}')">
        ${d}
        <div class="cal-dot-wrap">
          ${events.slice(0,3).map(()=>`<div class="cal-event-dot"></div>`).join('')}
        </div>
      </div>`;
  }
  
  // Next month filler
  const totalCells = firstDay + daysInMonth;
  const nextDays = (7 - (totalCells % 7)) % 7;
  for(let i = 1; i <= nextDays; i++){
    html += `<div class="cal-date other-month">${i}</div>`;
  }
  
  grid.innerHTML = html;
}

function showDayDetails(dateStr){
  // Highlight selected cell
  document.querySelectorAll('.cal-date').forEach(el => el.classList.remove('selected'));
  const allDates = Array.from(document.querySelectorAll('.cal-date'));
  const target = allDates.find(el => {
    const isOther = el.classList.contains('other-month');
    return !isOther && el.textContent.trim().split('\n')[0].trim() === String(parseInt(dateStr.split('-')[2]));
  });
  if(target) target.classList.add('selected');

  const detWrap = document.getElementById('calDayDetails');
  const detCont = document.getElementById('calDetailsContent');
  
  // Find events
  const dayEvents = [];
  entries.forEach(e => {
    e.revisions.forEach(r => {
      if(toLocalDate(new Date(r.datetime)) === dateStr){
        dayEvents.push({topic: e.topic, label: r.label, time: new Date(r.datetime).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})});
      }
    });
  });

  detWrap.style.display = 'block';
  if(!dayEvents.length){
    detCont.innerHTML = `<div class="empty-state" style="padding:20px;"><p>No revisions scheduled for this day.</p></div>`;
  } else {
    detCont.innerHTML = dayEvents.map(ev => `
      <div class="card" style="margin-bottom:8px; padding:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-size:0.85rem; font-weight:600; color:var(--text);">${ev.topic}</div>
            <div style="font-size:0.65rem; color:var(--text-dim); margin-top:2px;">${ev.time}</div>
          </div>
          <span class="iv-tag long">${ev.label}</span>
        </div>
      </div>
    `).join('');
  }
  
  setTimeout(() => detWrap.scrollIntoView({behavior:'smooth', block:'start'}), 100);
}
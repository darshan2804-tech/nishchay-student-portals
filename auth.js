// ============================================================
//  auth.js  –  Firebase Auth Module
//  Handles auth state, login, register, admin access.
// ============================================================

import { ADMIN_EMAILS } from './core-engine.js';

// ── Auth state listener ───────────────────────────────────────
export function initAuth(auth, db, { onApproved, onPending, onLoggedOut }) {
  auth.onAuthStateChanged(async user => {
    if (!user) { onLoggedOut(); return; }

    if (ADMIN_EMAILS.includes(user.email)) {
      try {
        await db.collection('users').doc(user.uid).set({
          name:      user.displayName || user.email.split('@')[0],
          email:     user.email,
          status:    'approved',
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (e) { /* first-run, ignore */ }
      onApproved(user);
      return;
    }

    try {
      const doc = await db.collection('users').doc(user.uid).get();
      if (!doc.exists) {
        await auth.signOut(); onLoggedOut();
        showAuthMsg('loginMsg', 'Account removed. Contact admin.', 'error');
        return;
      }
      const status = doc.data()?.status;
      if      (status === 'approved') onApproved(user);
      else if (status === 'pending')  onPending();
      else {
        await auth.signOut(); onLoggedOut();
        showAuthMsg('loginMsg', 'Access denied by admin.', 'error');
      }
    } catch (e) {
      await auth.signOut(); onLoggedOut();
      showAuthMsg('loginMsg', 'Permission denied. Contact admin.', 'error');
    }
  });
}

// ── Tab switcher ──────────────────────────────────────────────
export function showAuthTab(tab) {
  ['login', 'register', 'admin'].forEach(t => {
    const form = document.getElementById(`${t}Form`);
    const btn  = document.getElementById(`${t}Tab`);
    if (form) form.style.display = t === tab ? 'block' : 'none';
    if (btn)  Object.assign(btn.style, t === tab
      ? { background: tab === 'admin' ? '#d97706' : '#0ea5e9', color: '#fff' }
      : { background: 'transparent', color: '#64748b' }
    );
  });
}
window.showAuthTab = showAuthTab;

// ── Forgot password ───────────────────────────────────────────
export async function forgotPassword(auth) {
  const email = document.getElementById('loginEmail').value.trim();
  if (!email) { showAuthMsg('loginMsg', 'Please enter your email first.', 'error'); return; }
  try {
    await auth.sendPasswordResetEmail(email);
    showAuthMsg('loginMsg', `Reset email sent to ${email}!`, 'success');
  } catch (e) {
    showAuthMsg('loginMsg', 'Error sending reset email.', 'error');
  }
}

// ── Email login ───────────────────────────────────────────────
export async function doLogin(auth) {
  const email = document.getElementById('loginEmail').value.trim();
  const pass  = document.getElementById('loginPass').value;
  if (!email) { showAuthMsg('loginMsg', 'Please enter your email.', 'error'); return; }
  if (!pass)  { showAuthMsg('loginMsg', 'Please enter your password.', 'error'); return; }
  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-spinner"></span>Logging in…';
  showAuthMsg('loginMsg', 'Connecting…', 'info');
  try {
    await auth.signInWithEmailAndPassword(email, pass);
    showAuthMsg('loginMsg', 'Login successful! Loading…', 'success');
  } catch (e) {
    const m = {
      'auth/user-not-found':       'No account with this email.',
      'auth/wrong-password':        'Wrong password. Try again.',
      'auth/invalid-credential':    'Wrong email or password.',
      'auth/too-many-requests':     'Too many attempts. Try later.',
      'auth/network-request-failed':'No internet connection.'
    }[e.code] || 'Login failed. Check credentials.';
    showAuthMsg('loginMsg', m, 'error');
    btn.disabled = false;
    btn.innerHTML = 'Login to Study Tracker';
  }
}

// ── Admin login ───────────────────────────────────────────────
export async function doAdminLogin(auth) {
  const email = document.getElementById('adminEmail').value.trim();
  const pass  = document.getElementById('adminPass').value;
  if (!email) { showAuthMsg('adminMsg', 'Please enter your email.', 'error'); return; }
  if (!pass)  { showAuthMsg('adminMsg', 'Please enter your password.', 'error'); return; }
  if (!ADMIN_EMAILS.includes(email)) { showAuthMsg('adminMsg', 'Email not in admin list.', 'error'); return; }
  const btn = document.getElementById('adminLoginBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-spinner"></span>Logging in…';
  try {
    await auth.signInWithEmailAndPassword(email, pass);
  } catch (e) {
    const m = {
      'auth/wrong-password':     'Wrong password.',
      'auth/invalid-credential': 'Wrong email or password.',
      'auth/too-many-requests':  'Too many attempts. Try later.'
    }[e.code] || 'Login failed.';
    showAuthMsg('adminMsg', m, 'error');
    btn.disabled = false;
    btn.innerHTML = '⚙️ Login as Admin';
  }
}

// ── Registration ──────────────────────────────────────────────
export async function doRegister(auth, db) {
  const name  = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const phone = document.getElementById('regPhone').value.trim();
  const pass  = document.getElementById('regPass').value;
  if (!name || !email || !phone || !pass) { showAuthMsg('registerMsg', 'Please fill all fields.', 'error'); return; }
  if (pass.length < 6) { showAuthMsg('registerMsg', 'Password must be ≥ 6 characters.', 'error'); return; }
  const btn = document.getElementById('registerBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-spinner"></span>Submitting…';
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, pass);
    await cred.user.updateProfile({ displayName: name });
    const ts = firebase.firestore.FieldValue.serverTimestamp();
    await db.collection('users').doc(cred.user.uid).set({ name, email, phone, status: 'pending', createdAt: ts });
    await db.collection('requests').doc(cred.user.uid).set({ name, email, phone, status: 'pending', uid: cred.user.uid, createdAt: ts });
    document.querySelector('.screen.active')?.classList.remove('active');
    document.getElementById('pendingScreen').classList.add('active');
  } catch (e) {
    const m = {
      'auth/email-already-in-use': 'Email already registered. Try logging in.',
      'auth/invalid-email':         'Invalid email address.'
    }[e.code] || 'Registration failed.';
    showAuthMsg('registerMsg', m, 'error');
    btn.disabled = false;
    btn.innerHTML = 'Request Access';
  }
}

// ── Check approval (from pending screen) ──────────────────────
export async function checkApproval(auth, db, currentUser, onApproved) {
  if (!currentUser) return;
  try {
    const doc = await db.collection('users').doc(currentUser.uid).get();
    if (!doc.exists || !['approved','pending'].includes(doc.data()?.status)) {
      await auth.signOut();
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      document.getElementById('authScreen').classList.add('active');
      showAuthMsg('loginMsg', 'Account removed or access denied.', 'error');
    } else if (doc.data()?.status === 'approved') {
      onApproved(currentUser);
    } else {
      showToastGlobal('Still pending. Please wait for admin approval.');
    }
  } catch (e) { showToastGlobal('Error checking status. Try again.'); }
}

// ── Logout ────────────────────────────────────────────────────
export function doLogout(auth, clearState) {
  if (confirm('Are you sure you want to logout?')) {
    clearState();
    auth.signOut();
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('authScreen').classList.add('active');
  }
}

// ── Shared auth message helper ────────────────────────────────
function showAuthMsg(id, msg, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  const styles = {
    error:   'color:#dc2626;background:#fef2f2;border:1px solid #fecaca;',
    success: 'color:#16a34a;background:#f0fdf4;border:1px solid #bbf7d0;',
    info:    'color:#0284c7;background:#e0f2fe;border:1px solid #bae6fd;'
  };
  el.style.cssText = (styles[type] || '') + 'border-radius:8px;padding:8px;text-align:center;font-size:0.75rem;font-weight:500;margin-top:10px;display:block;';
}

function showToastGlobal(msg) {
  const ex = document.querySelector('.toast'); if (ex) ex.remove();
  const t  = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 3400);
}

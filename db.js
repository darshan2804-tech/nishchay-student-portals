// ============================================================
//  db.js  –  Firestore SSOT Data Layer
//  All data flows through Firestore. Zero localStorage.
//  Real-time onSnapshot replaces any polling / caching.
// ============================================================

let _unsubEntries = null;

// ── Real-time entries listener (SSOT) ─────────────────────────
export function listenToEntries(db, userId, onUpdate, onError) {
  if (_unsubEntries) { _unsubEntries(); _unsubEntries = null; }

  _unsubEntries = db
    .collection('users').doc(userId)
    .collection('entries')
    .orderBy('createdAt', 'desc')
    .onSnapshot(
      snap => onUpdate(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      err  => { console.error('[db] listener error:', err); if (onError) onError(err); }
    );

  return () => { if (_unsubEntries) { _unsubEntries(); _unsubEntries = null; } };
}

export function stopListening() {
  if (_unsubEntries) { _unsubEntries(); _unsubEntries = null; }
}

// ── Entry CRUD ────────────────────────────────────────────────
export async function saveEntry(db, userId, entry) {
  const serialized = {
    ...entry,
    revisions: (entry.revisions || []).map(r => ({
      ...r,
      datetime: r.datetime instanceof Date ? r.datetime.toISOString() : r.datetime
    })),
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  await db.collection('users').doc(userId)
    .collection('entries').doc(String(entry.id)).set(serialized);
}

export async function deleteEntry(db, userId, id) {
  await db.collection('users').doc(userId)
    .collection('entries').doc(String(id)).delete();
}

// ── Done-keys (tracks completed revisions) ────────────────────
export async function saveDoneKeys(db, userId, dateStr, keysArray) {
  try {
    await db.collection('users').doc(userId)
      .collection('donekeys').doc(dateStr)
      .set({ keys: keysArray, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
  } catch (e) { console.warn('[db] saveDoneKeys failed:', e.message); }
}

export async function getDoneKeys(db, userId, dateStr) {
  try {
    const doc = await db.collection('users').doc(userId)
      .collection('donekeys').doc(dateStr).get();
    return doc.exists ? new Set(doc.data().keys || []) : new Set();
  } catch (e) { return new Set(); }
}

// ── Exam dates ────────────────────────────────────────────────
export async function saveExamDates(db, userId, data) {
  await db.collection('users').doc(userId)
    .collection('settings').doc('examdates').set(data);
}

export async function getExamDates(db, userId) {
  try {
    const doc = await db.collection('users').doc(userId)
      .collection('settings').doc('examdates').get();
    return doc.exists ? doc.data() : {};
  } catch (e) { return {}; }
}

// ── Study target ──────────────────────────────────────────────
export async function saveStudyTarget(db, userId, hours) {
  await db.collection('users').doc(userId)
    .collection('settings').doc('studytarget').set({ hours });
}

export async function getStudyTarget(db, userId) {
  try {
    const doc = await db.collection('users').doc(userId)
      .collection('settings').doc('studytarget').get();
    return doc.exists ? (doc.data().hours || 6) : 6;
  } catch (e) { return 6; }
}

// ── Study time (daily) ────────────────────────────────────────
export async function saveStudyTime(db, userId, dateStr, data) {
  await db.collection('users').doc(userId)
    .collection('studytime').doc(dateStr).set(data, { merge: true });
}

export async function getStudyTime(db, userId, dateStr) {
  try {
    const doc = await db.collection('users').doc(userId)
      .collection('studytime').doc(dateStr).get();
    return doc.exists ? doc.data() : {};
  } catch (e) { return {}; }
}

// ── Push subscription endpoint ────────────────────────────────
export async function savePushSubscription(db, userId, endpoint) {
  await db.collection('users').doc(userId)
    .collection('settings').doc('pushsub')
    .set({ endpoint, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

// ── Mistake notebook ──────────────────────────────────────────
export async function saveMistake(db, userId, mistake) {
  await db.collection('users').doc(userId).collection('mistakes').add({
    ...mistake, createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

export async function getMistakes(db, userId) {
  try {
    const snap = await db.collection('users').doc(userId)
      .collection('mistakes').orderBy('createdAt', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) { return []; }
}

export async function deleteMistake(db, userId, id) {
  await db.collection('users').doc(userId).collection('mistakes').doc(id).delete();
}

// ── Mock scores ───────────────────────────────────────────────
export async function saveMockScore(db, userId, scoreObj) {
  await db.collection('users').doc(userId).collection('mockscores').add({
    ...scoreObj, createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

export async function getMockScores(db, userId) {
  try {
    const snap = await db.collection('users').doc(userId)
      .collection('mockscores').orderBy('createdAt', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) { return []; }
}

// ── Platform Global Settings ──────────────────────────────────
export function listenToSiteSettings(db, callback) {
  return db.collection('site_settings').doc('global').onSnapshot(
    doc => {
      if (doc.exists) callback(doc.data());
      else callback({});
    },
    err => console.warn('[db] site_settings listener error:', err)
  );
}


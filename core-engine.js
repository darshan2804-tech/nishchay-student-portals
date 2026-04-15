// ============================================================
//  core-engine.js  –  Spaced Repetition & Analytics Engine
//  Single Source of Truth for all calculation logic.
//  Zero DOM, zero storage – pure functions only.
// ============================================================

export const INTERVALS = [
  { label: '12 hrs', mins: 720,   type: 'short' },
  { label: 'Day 1',  mins: 1440,  type: 'long'  },
  { label: 'Day 2',  mins: 2880,  type: 'long'  },
  { label: 'Day 4',  mins: 5760,  type: 'long'  },
  { label: 'Day 7',  mins: 10080, type: 'long'  },
  { label: 'Day 15', mins: 21600, type: 'long'  },
  { label: 'Day 30', mins: 43200, type: 'long'  }
];

export const ADMIN_EMAILS = ['darshanderkar20@gmail.com', 'derkardarshan@gmail.com'];

export const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyBRw3GxukFyPEcjOY-0FIsXBk2p-7TQivM',
  authDomain:        'study-tracker-52de8.firebaseapp.com',
  projectId:         'study-tracker-52de8',
  storageBucket:     'study-tracker-52de8.firebasestorage.app',
  messagingSenderId: '183173939785',
  appId:             '1:183173939785:web:5fc5eee2f86b87c356b598'
};

// ── Date helpers ──────────────────────────────────────────────
export const p = n => String(n).padStart(2, '0');

export function toLocalDate(d) {
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Revision schedule calculator ─────────────────────────────
export function calcDates(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, mi]   = (timeStr || '00:00').split(':').map(Number);
  const base       = new Date(y, m - 1, d, h, mi, 0);
  return INTERVALS.map(iv => ({ ...iv, datetime: new Date(base.getTime() + iv.mins * 60000) }));
}

// ── Subject auto-detector ─────────────────────────────────────
export function detectSubject(topic) {
  const t = (topic || '').toLowerCase();
  if (/phy|motion|force|energy|wave|optic|electric|magnet|thermo/.test(t)) return 'Physics';
  if (/chem|organic|inorganic|acid|reaction|element|bond|mole/.test(t))    return 'Chemistry';
  if (/math|calculus|algebra|trigon|coord|vector|matrix|integral|diff|equation|quadratic/.test(t)) return 'Maths';
  return 'Physics';
}

// ── Streak calculator ─────────────────────────────────────────
export function calcStreak(entries) {
  const studyDays = new Set(entries.map(e => e.dateStr));
  let current = 0, longest = 0, temp = 0;
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
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

// ── Today's revision items ────────────────────────────────────
export function getTodayItems(entries, doneSet = new Set()) {
  const today = toLocalDate(new Date());
  const items  = [];
  entries.forEach(entry => {
    (entry.revisions || []).forEach(r => {
      const rDate = r.datetime instanceof Date ? r.datetime : new Date(r.datetime);
      if (toLocalDate(rDate) === today) {
        const key = `${entry.id}_${r.label}`;
        items.push({ topic: entry.topic, label: r.label, datetime: rDate, key, done: doneSet.has(key) });
      }
    });
  });
  return items.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
}

// ── Performance score (30-day rolling window) ─────────────────
export function calcPerformanceScore(entries, allDoneKeys = new Set()) {
  if (!entries.length) return { score: 0, done: 0, pending: 0, label: 'Start studying!' };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let totalDue = 0, totalDone = 0;
  entries.forEach(entry => {
    (entry.revisions || []).forEach(r => {
      const rDate = new Date(r.datetime instanceof Date ? r.datetime : new Date(r.datetime));
      rDate.setHours(0, 0, 0, 0);
      if (rDate <= today) {
        totalDue++;
        if (allDoneKeys.has(`${entry.id}_${r.label}`)) totalDone++;
      }
    });
  });
  const score   = totalDue > 0 ? Math.round(totalDone / totalDue * 100) : 0;
  const pending = totalDue - totalDone;
  const label   = score >= 90 ? '🔥 Excellent!' : score >= 70 ? '✅ Good progress!' : score >= 50 ? '📈 Getting there!' : score >= 30 ? '💪 Keep pushing!' : '🚀 Just getting started!';
  return { score, done: totalDone, pending, label };
}

// ── Subject topic counter ─────────────────────────────────────
export function countSubjects(entries) {
  const counts = { Physics: 0, Chemistry: 0, Maths: 0 };
  entries.forEach(e => {
    const s = detectSubject(e.topic);
    counts[s] = (counts[s] || 0) + 1;
  });
  return counts;
}

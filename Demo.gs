/**
 * ============================================================================
 *  DART — DEMO MODE   (file: Demo.gs — add as a NEW script file)
 * ============================================================================
 *  Turns a COPY of DART into a public portfolio demo:
 *    - No sign-in page. Visitors open the link and land on the dashboard as
 *      "Guest Visitor" (Staff-level: can browse, log/edit incidents, record
 *      conferences, generate reports — cannot delete, change settings,
 *      manage users, see the audit log, or upload files).
 *    - Admin access is hidden at  <web-app-url>?admin=1 . If you open it while
 *      signed in to the Google account that owns the script, you are Admin
 *      automatically. Anyone else sees a password sign-in (accounts you create
 *      on the Users page).
 *    - Every record is FICTIONAL ("Sample, Juan D.", "DEMO-25-0001", ...).
 *    - The data resets every night (time trigger) so the demo stays clean.
 *
 *  ONE-TIME SETUP (run from the Apps Script editor, in the DEMO copy only):
 *    1. setupDemo()   -> clears real accounts, creates "DART DEMO" folders,
 *                        creates a report template, seeds fake data and
 *                        installs the nightly reset.
 *    2. Deploy -> New deployment -> Web app
 *         Execute as: Me    |    Who has access: Anyone
 *
 *  Other functions you can run from the editor:
 *    resetDemoData()     -> wipe visitor changes and re-seed fake data now
 *    installDemoReset()  -> (re)create the nightly reset trigger
 * ============================================================================
 */

const DEMO = Object.freeze({
  ENABLED: true,
  // The script owner is always Admin at ?admin=1. Add other Google accounts here if needed (lowercase).
  ADMIN_EMAILS: [],
  MAX_WRITES_PER_VISITOR: 40,     // changes one visitor can make per session (6 h)
  MAX_WRITES_ALL_VISITORS: 600,   // all visitors combined, per 6 h (abuse guard)
  RESET_HOUR: 2,                  // nightly reset hour (script time zone)
  CLEAN_DRIVE_ON_RESET: true,     // trash generated PDFs in the DEMO folders on reset
  EVIDENCE_FOLDER: 'DART DEMO - Evidence',
  REPORTS_FOLDER: 'DART DEMO - Reports',
  SEED: { students: 34, incidents: 120, months: 9 }
});

/** Session length for password-less demo sessions (6 hours = CacheService maximum). */
const DEMO_SESSION_TTL = 21600;

/** Actions that change data or create files — counted against the visitor limit. */
const DEMO_WRITE_ACTIONS = ['insertViolation', 'updateViolation', 'saveConference', 'generatePDFReport', 'generateSummaryReport'];
/** Staff-level actions visitors still cannot use. (Admin-only actions are already blocked by role.) */
const DEMO_VISITOR_BLOCKED = ['changeOwnPassword'];

const DEMO_INFRACTIONS = [
  { name: 'Tardiness', severity: 'Minor', weight: 30 },
  { name: 'Improper Uniform', severity: 'Minor', weight: 22 },
  { name: 'Use of Mobile Phone in Class', severity: 'Minor', weight: 18 },
  { name: 'Cutting Classes', severity: 'Major', weight: 10 },
  { name: 'Disrespect to Authority', severity: 'Major', weight: 7 },
  { name: 'Academic Dishonesty', severity: 'Major', weight: 6 },
  { name: 'Bullying', severity: 'Grave', weight: 4 },
  { name: 'Vandalism', severity: 'Grave', weight: 3 }
];

const DEMO_REMARKS = {
  'Tardiness': ['Arrived after the 7:30 AM bell without an excuse slip.', 'Late for first period; noted by the homeroom adviser.'],
  'Improper Uniform': ['Not wearing the prescribed ID lace and school shoes.', 'Came to class in a non-uniform jacket.'],
  'Use of Mobile Phone in Class': ['Playing mobile games during a quiz; device held until dismissal.', 'Took a call during class without permission.'],
  'Cutting Classes': ['Left campus during 3rd period without a gate pass.', 'Absent from afternoon classes but seen at the canteen.'],
  'Disrespect to Authority': ['Raised voice at the subject teacher during class discussion.', 'Refused to follow instructions from the guidance staff.'],
  'Academic Dishonesty': ['Copied answers from a seatmate during a long test.', 'Submitted an essay copied word-for-word from a website.'],
  'Bullying': ['Repeated name-calling of a classmate, reported by two witnesses.', 'Posted mocking comments about a classmate in a group chat.'],
  'Vandalism': ['Wrote on the comfort room wall with a permanent marker.', 'Damaged a classroom chair during break time.']
};

const DEMO_CONF_TEXT = {
  'Held': ['Discussed the student\'s recent offenses with the guardian and class adviser.', 'Guardian agreed to monitor attendance; student signed a behavior contract.'],
  'Scheduled': ['Invitation letter sent home with the student.', ''],
  'Rescheduled': ['Guardian asked for a new schedule because of work.', ''],
  'No-show': ['Guardian did not attend; adviser made a follow-up call.', 'A second invitation will be sent.']
};

// ============================================================================
// PUBLIC (browser-callable) — replaces the sign-in page
// ============================================================================

/**
 * Starts a session without a password.
 * Owner's Google account -> Admin. Everyone else -> Guest Visitor.
 * asVisitor = true lets the owner preview the visitor view.
 */
function startPublicSession(asVisitor) {
  demoCheckInstall_();
  if (!DEMO.ENABLED) throw new Error('Demo mode is turned off. Please use Admin sign-in.');
  const email = demoActiveEmail_();
  let owner = '';
  try { owner = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase(); } catch (e) { owner = ''; }
  const isOwner = !asVisitor && !!email && (email === owner || DEMO.ADMIN_EMAILS.some(function (a) {
    return String(a).trim().toLowerCase() === email;
  }));
  const s = isOwner
    ? { virtual: 'owner', email: email }
    : { virtual: 'visitor', id: Utilities.getUuid().replace(/-/g, '').slice(0, 6) };
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify(s), DEMO_SESSION_TTL);
  CURRENT_USER_ = virtualUser_(s);
  if (isOwner) audit_('LOGIN', 'Session', 'OWNER', { via: 'Google account' });
  return { token: token, user: publicUser_(CURRENT_USER_), mode: isOwner ? 'owner' : 'visitor' };
}

// ============================================================================
// HELPERS USED BY Code.gs (requireSession_, apiCall, bootstrap_)
// ============================================================================

/** Clear message when Code.gs is missing or incomplete (instead of "CONFIG is not defined"). */
function demoCheckInstall_() {
  if (typeof CONFIG === 'undefined' || typeof apiCall !== 'function' || typeof publicUser_ !== 'function') {
    throw new Error('Setup problem: Code.gs is missing or incomplete in this Apps Script project. Paste the full demo Code.gs, save, then deploy a new version.');
  }
}

function demoActiveEmail_() {
  try { return String(Session.getActiveUser().getEmail() || '').trim().toLowerCase(); } catch (e) { return ''; }
}

/** Builds the in-memory user for a password-less session. */
function virtualUser_(s) {
  const base = { password_hash: '', salt: '', is_active: true, created_at: '', last_login: new Date(), isVirtual: true };
  if (s && s.virtual === 'owner') {
    return Object.assign(base, { user_id: 'OWNER', username: 'owner', display_name: 'ADMIN', role: 'Admin' });
  }
  return Object.assign(base, {
    user_id: 'VISITOR-' + String((s && s.id) || 'guest'),
    username: 'visitor',
    display_name: 'GUEST VISITOR',
    role: 'Staff',
    isVisitor: true
  });
}

/** Called by apiCall before every action. Enforces the visitor rules on the SERVER. */
function demoGuard_(user, action, args, token) {
  if (!user) return;
  if (user.isVirtual && action === 'changeOwnPassword') {
    throw new Error('This session has no password. Create a password account on the Users page if you need one.');
  }
  if (!user.isVisitor) return;
  if (DEMO_VISITOR_BLOCKED.indexOf(action) !== -1) throw new Error('This is not available in the demo.');
  const payload = args && args[0];
  if ((action === 'insertViolation' || action === 'updateViolation') && payload && payload.evidence_file) {
    throw new Error('Demo mode: photo uploads are turned off. Paste an evidence link instead.');
  }
  if (DEMO_WRITE_ACTIONS.indexOf(action) === -1) return;

  const cache = CacheService.getScriptCache();
  const keyMine = 'demo_w_' + token;
  const mine = parseInt(cache.get(keyMine) || '0', 10);
  const all = parseInt(cache.get('demo_w_all') || '0', 10);
  if (mine >= DEMO.MAX_WRITES_PER_VISITOR) {
    throw new Error('Demo limit reached (' + DEMO.MAX_WRITES_PER_VISITOR + ' changes per visit). Thanks for trying DART!');
  }
  if (all >= DEMO.MAX_WRITES_ALL_VISITORS) throw new Error('The demo is busy right now. Please try again later.');
  cache.put(keyMine, String(mine + 1), DEMO_SESSION_TTL);
  cache.put('demo_w_all', String(all + 1), DEMO_SESSION_TTL);
}

/** Extra info returned by bootstrap_ so the page can show the demo banner. */
function demoInfo_() {
  const u = CURRENT_USER_ || {};
  return {
    enabled: DEMO.ENABLED,
    isVisitor: !!u.isVisitor,
    isVirtual: !!u.isVirtual,
    maxWrites: DEMO.MAX_WRITES_PER_VISITOR,
    resetHour: DEMO.RESET_HOUR,
    lastReset: PropertiesService.getScriptProperties().getProperty('DEMO_LAST_RESET') || ''
  };
}

// ============================================================================
// EDITOR-ONLY SETUP & RESET
// ============================================================================

/** One-time setup of the DEMO copy. Run from the editor. */
function setupDemo() {
  demoCheckInstall_();
  assertEditor_();
  const props = PropertiesService.getScriptProperties();
  // Forget any folder/template/setup key inherited from the real DART.
  [PROP_KEYS.EVIDENCE_FOLDER, PROP_KEYS.REPORTS_FOLDER, PROP_KEYS.TEMPLATE_DOC, PROP_KEYS.SETUP_KEY]
    .forEach(function (k) { props.deleteProperty(k); });

  const ss = getSpreadsheet_();
  Object.keys(SHEET_HEADERS).forEach(function (name) { ensureSheet_(ss, name, SHEET_HEADERS[name]); });

  // Remove every real account and reset dropdown options to the defaults.
  clearDataRows_(SHEET_NAMES.USERS, true);
  clearDataRows_(SHEET_NAMES.SETTINGS, true);
  seedDefaultSettings_(getSheet_(SHEET_NAMES.SETTINGS));

  props.setProperty(PROP_KEYS.EVIDENCE_FOLDER, demoFolder_(DEMO.EVIDENCE_FOLDER).getId());
  props.setProperty(PROP_KEYS.REPORTS_FOLDER, demoFolder_(DEMO.REPORTS_FOLDER).getId());

  let templateNote;
  if (String(CONFIG.TEMPLATE_DOC_ID || '').indexOf('DUMMY') === 0 || !CONFIG.TEMPLATE_DOC_ID) {
    createSampleTemplate();
    templateNote = 'New report template created.';
  } else {
    templateNote = 'Using CONFIG.TEMPLATE_DOC_ID for reports.';
  }

  const resetMsg = resetDemoData();
  installDemoReset();

  const msg = [
    'DART DEMO is ready.',
    resetMsg,
    templateNote,
    'Real user accounts removed. Admin page: <web-app-url>?admin=1 (automatic for ' + Session.getEffectiveUser().getEmail() + ').',
    'Nightly reset installed at ' + DEMO.RESET_HOUR + ':00.',
    '',
    'NEXT: Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone > Deploy.'
  ].join('\n');
  Logger.log(msg);
  return msg;
}

/** Wipes visitor changes and re-seeds the fictional data. Runs nightly via trigger. */
function resetDemoData(e) {
  const fromTrigger = !!(e && e.triggerUid) && ScriptApp.getProjectTriggers().some(function (t) {
    return t.getUniqueId() === String(e.triggerUid);
  });
  if (!fromTrigger) assertEditor_();

  const summary = withLock_(function () {
    const ss = getSpreadsheet_();
    Object.keys(SHEET_HEADERS).forEach(function (name) { ensureSheet_(ss, name, SHEET_HEADERS[name]); });
    [SHEET_NAMES.LOGS, SHEET_NAMES.CONFERENCES, SHEET_NAMES.AUDIT].forEach(function (n) { clearDataRows_(n, false); });
    seedDefaultSettings_(getSheet_(SHEET_NAMES.SETTINGS));
    return seedDemoRecords_();
  });

  if (DEMO.CLEAN_DRIVE_ON_RESET) cleanDemoFolders_();
  CacheService.getScriptCache().remove('demo_w_all');
  PropertiesService.getScriptProperties().setProperty('DEMO_LAST_RESET', new Date().toISOString());
  CURRENT_USER_ = null;
  audit_('DEMO_RESET', 'System', 'demo', summary);

  const msg = 'Demo data reset: ' + summary.students + ' students, ' + summary.incidents +
    ' incidents, ' + summary.conferences + ' parent conferences.';
  Logger.log(msg);
  return msg;
}

/** (Re)creates the nightly reset trigger. */
function installDemoReset() {
  assertEditor_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'resetDemoData') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('resetDemoData').timeBased().everyDays(1).atHour(DEMO.RESET_HOUR).create();
  const msg = 'Nightly demo reset scheduled at ' + DEMO.RESET_HOUR + ':00 (' + Session.getScriptTimeZone() + ').';
  Logger.log(msg);
  return msg;
}

// ============================================================================
// INTERNALS
// ============================================================================

function clearDataRows_(name, alsoValidations) {
  const sheet = getSheet_(name);
  const rows = sheet.getMaxRows() - 1;
  if (rows < 1) return;
  const range = sheet.getRange(2, 1, rows, sheet.getMaxColumns());
  range.clearContent();
  if (alsoValidations) range.clearDataValidations();
}

function demoFolder_(name) {
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

/** Trashes generated files — only inside folders whose name contains "DEMO". */
function cleanDemoFolders_() {
  const props = PropertiesService.getScriptProperties();
  [PROP_KEYS.EVIDENCE_FOLDER, PROP_KEYS.REPORTS_FOLDER].forEach(function (key) {
    const id = props.getProperty(key);
    if (!id) return;
    try {
      const folder = DriveApp.getFolderById(id);
      if (folder.getName().toUpperCase().indexOf('DEMO') === -1) {
        Logger.log('Skipped cleaning "' + folder.getName() + '" (not a DEMO folder).');
        return;
      }
      const files = folder.getFiles();
      while (files.hasNext()) files.next().setTrashed(true);
    } catch (err) {
      Logger.log('Drive cleanup skipped: ' + err.message);
    }
  });
}

/** Small seeded random generator so the demo looks the same after every reset. */
function demoRandom_(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function demoStudents_(R, pick) {
  const FIRST = ['Juan', 'Maria', 'Jose', 'Ana', 'Mark', 'Kyla', 'Paolo', 'Bea', 'Carlo', 'Trisha', 'Miguel', 'Jasmine',
    'Rafael', 'Nicole', 'Daniel', 'Angela', 'Kevin', 'Sofia', 'Gabriel', 'Erika', 'Joshua', 'Princess', 'Luis', 'Camille'];
  const LAST = ['Sample', 'Testcase', 'Placeholder', 'Example', 'Mockup', 'Dummy', 'Fakerson', 'Prototype',
    'Lorem', 'Ipsum', 'Sandbox', 'Democruz'];
  const SECTIONS = ['STEM 11-Demo A', 'STEM 12-Demo B', 'ABM 11-Demo A', 'ABM 12-Demo B',
    'HUMSS 11-Demo C', 'HUMSS 12-Demo A', 'TVL 12-Demo C', 'GAS 11-Demo B'];
  const list = [];
  const used = {};
  for (let i = 0; list.length < DEMO.SEED.students && i < 2000; i++) {
    const first = FIRST[i % FIRST.length];
    const last = pick(LAST);
    if (used[last + first]) continue;
    used[last + first] = true;
    const k = list.length;
    list.push({
      id: 'DEMO-' + (k % 2 ? '24' : '25') + '-' + ('000' + (k + 1)).slice(-4),
      name: last + ', ' + first + ' ' + 'ABCDEFGLMNRST'.charAt(Math.floor(R() * 13)) + '.',
      section: pick(SECTIONS),
      guardian: (R() < 0.5 ? 'Mrs. ' : 'Mr. ') + last + ' (sample guardian)',
      weight: k < 8 ? 5 : (k < 18 ? 2 : 1)
    });
  }
  return list;
}

function demoWeighted_(R, items, weightOf) {
  let total = 0;
  items.forEach(function (x) { total += weightOf(x); });
  let r = R() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weightOf(items[i]);
    if (r < 0) return items[i];
  }
  return items[items.length - 1];
}

function demoTimestamp_(R, now, days, i) {
  const daysAgo = i < 6 ? Math.floor(R() * 4) : Math.floor(Math.pow(R(), 1.3) * days);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 7 + Math.floor(R() * 9), Math.floor(R() * 60));
  if (d.getDay() === 0) d.setDate(d.getDate() - 2);
  if (d.getDay() === 6) d.setDate(d.getDate() - 1);
  if (d > now) return new Date(now.getTime() - (30 + Math.floor(R() * 180)) * 60000);
  return d;
}

function demoSanction_(severity, n) {
  if (severity === 'Grave') return n >= 2 ? 'Suspension' : 'Parent Conference';
  if (severity === 'Major') return n >= 3 ? 'Community Service' : (n === 2 ? 'Parent Conference' : 'Written Warning');
  return n >= 3 ? 'Parent Conference' : (n === 2 ? 'Written Warning' : 'Verbal Warning');
}

function demoStatus_(R, ageDays) {
  if (ageDays > 45) return R() < 0.8 ? 'Resolved' : 'Adjudicated';
  if (ageDays > 10) return ['Adjudicated', 'Resolved', 'Under Investigation'][Math.floor(R() * 3)];
  return R() < 0.6 ? 'Pending' : 'Under Investigation';
}

/** Writes records starting at row 2 (sheet must be cleared first). */
function writeDemoRecords_(name, headers, records) {
  if (!records.length) return;
  const sheet = getSheet_(name);
  const table = readTable_(sheet, headers);
  const values = records.map(function (rec) {
    const row = new Array(table.width).fill('');
    headers.forEach(function (h) { row[table.map[h]] = sanitizeCell_(rec[h]); });
    return row;
  });
  sheet.getRange(2, 1, values.length, table.width).setValues(values);
  if ('timestamp' in table.map) {
    sheet.getRange(2, table.map.timestamp + 1, values.length, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  }
  SpreadsheetApp.flush();
}

function seedDemoRecords_() {
  const R = demoRandom_(2026);
  const pick = function (arr) { return arr[Math.floor(R() * arr.length)]; };
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const students = demoStudents_(R, pick);

  // Incidents, oldest first so frequencies count up correctly
  const incidents = [];
  for (let i = 0; i < DEMO.SEED.incidents; i++) {
    incidents.push({
      st: demoWeighted_(R, students, function (s) { return s.weight; }),
      inf: demoWeighted_(R, DEMO_INFRACTIONS, function (x) { return x.weight; }),
      ts: demoTimestamp_(R, now, DEMO.SEED.months * 30, i)
    });
  }
  incidents.sort(function (a, b) { return a.ts - b.ts; });

  const labels = getFrequencyLabels_();
  const perInfraction = {};
  const perStudent = {};
  const logs = incidents.map(function (x, i) {
    const key = x.st.id + '|' + x.inf.name;
    perInfraction[key] = (perInfraction[key] || 0) + 1;
    perStudent[x.st.id] = (perStudent[x.st.id] || 0) + 1;
    if (perStudent[x.st.id] === CONFIG.ESCALATION_THRESHOLD) x.st.escalatedAt = x.ts;
    const n = perInfraction[key];
    return {
      log_id: 'LOG-DEMO-' + ('000' + (i + 1)).slice(-4),
      timestamp: x.ts,
      student_id: x.st.id,
      student_name: x.st.name,
      section: x.st.section,
      infraction: x.inf.name,
      severity: x.inf.severity,
      frequency: resolveFrequencyLabel_(n, labels),
      sanction: demoSanction_(x.inf.severity, n),
      remarks: pick(DEMO_REMARKS[x.inf.name]),
      evidence_link: '',
      report_pdf_link: '',
      remark_status: demoStatus_(R, (now - x.ts) / 86400000)
    };
  });
  writeDemoRecords_(SHEET_NAMES.LOGS, LOG_HEADERS, logs);

  // Parent conferences for most students who reached the escalation threshold
  const conferences = [];
  const PAST_STATUS = ['Held', 'Held', 'Rescheduled', 'Held', 'No-show', 'Held'];
  const escalated = students.filter(function (s) { return s.escalatedAt; })
    .sort(function (x, y) { return x.escalatedAt - y.escalatedAt; });
  escalated.forEach(function (s, idx) {
    const upcoming = idx >= escalated.length - 3;           // the 3 most recent cases are still scheduled
    if (!upcoming && idx % 4 === 3) return;                 // a few escalated students have no conference yet
    const e = s.escalatedAt;
    let date = new Date(e.getFullYear(), e.getMonth(), e.getDate() + 3 + Math.floor(R() * 8), 9 + Math.floor(R() * 6), 0);
    if (upcoming && date <= now) date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2 + idx % 5, 10, 0);
    if (!upcoming && date > now) date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1 - idx % 5, 10, 0);
    const status = upcoming ? 'Scheduled' : PAST_STATUS[idx % PAST_STATUS.length];
    const created = new Date(Math.min(date.getTime() - 2 * 86400000, now.getTime()));
    conferences.push({
      conference_id: 'CNF-DEMO-' + ('00' + (conferences.length + 1)).slice(-3),
      student_id: s.id,
      student_name: s.name,
      section: s.section,
      conference_date: date,
      status: status,
      guardian_name: s.guardian,
      notes: DEMO_CONF_TEXT[status][0],
      outcome: DEMO_CONF_TEXT[status][1],
      recorded_by: 'demo.seed',
      created_at: created,
      updated_at: date > now ? created : date
    });
  });
  writeDemoRecords_(SHEET_NAMES.CONFERENCES, CONFERENCE_HEADERS, conferences);

  return { students: Object.keys(perStudent).length, incidents: logs.length, conferences: conferences.length };
}

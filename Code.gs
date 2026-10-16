/**
 * ============================================================================
 *  DART — Disciplinary Action & Resolution Tracker
 *  PUBLIC PORTFOLIO DEMO — fictional school, fictional students (see Demo.gs)
 *  File: Code.gs  (Backend)
 * ============================================================================
 *  DEMO SETUP: run setupDemo() in Demo.gs instead of the steps below.
 *
 *  FIRST-TIME SETUP (run once from the Apps Script editor):
 *    1. setupDatabase()        -> creates/validates all tabs, seeds settings, creates Drive folders
 *    2. createSampleTemplate() -> creates the incident report template Doc (with logo)
 *    3. Deploy -> New deployment -> Web app -> Execute as: Me
 *    4. Open the web app URL and create the first Admin account on the setup screen.
 *
 *  SECURITY MODEL
 *    - Users sign in with a DART username + password (stored as salted SHA-256 hashes
 *      in the Authorized_Users tab). Sessions are random tokens kept in CacheService.
 *    - The browser can only reach: getPublicConfig, createFirstAdmin, login, logout,
 *      apiCall. Every data function is private (ends with "_") and is reached only
 *      through apiCall(), which validates the session and the user's role.
 *    - Roles: Admin (full access) and Staff (log/edit incidents, conferences, reports,
 *      exports; cannot delete incidents, change settings, manage users or view audit log).
 *    - Every create / update / delete / login / report / export is written to Audit_Log.
 *
 *  DATA INTEGRITY RULES
 *    - Every update/delete locates rows by matching their unique ID at the moment of
 *      the write, inside a script lock. Physical row positions are never trusted.
 *    - Columns are resolved by header name; missing columns are added automatically.
 *    - User text is written as literal text (blocks formula injection / auto-conversion).
 * ============================================================================
 */

// ============================================================================
// 1. CONFIGURATION
// ============================================================================

const CONFIG = Object.freeze({
  APP_TITLE: 'DART | Disciplinary Action & Resolution Tracker',
  APP_SHORT_NAME: 'DART',
  SCHOOL_NAME: 'Sample Senior High School (Demo)',
  DEPARTMENT_NAME: 'Senior High School Department',
  LOGO_FILE_NAME: 'Logo',                              // Apps Script HTML file that holds the logo (data:image/png;base64,...)
  REPORT_LOGO_WIDTH: 90,                               // Logo width in PDF reports (pixels)
  SPREADSHEET_ID: '',                                  // Leave blank if this script is bound to the spreadsheet
  TEMPLATE_DOC_ID: 'DUMMY_TEMPLATE_DOC_ID_REPLACE_ME', // Replace with your Google Doc template ID (or run createSampleTemplate())
  EVIDENCE_FOLDER_NAME: 'DART DEMO - Evidence',
  REPORTS_FOLDER_NAME: 'DART DEMO - Reports',
  SHARE_FILES_WITH_LINK: false,                        // true = anyone with the link can view evidence/reports
  ESCALATION_THRESHOLD: 3,                             // Overall offense count that triggers the parent-conference warning
  MAX_UPLOAD_BYTES: 10 * 1024 * 1024,                  // 10 MB
  LOCK_TIMEOUT_MS: 30000,
  SESSION_TTL_SECONDS: 21600,                          // 6 hours (CacheService maximum)
  PASSWORD_MIN_LENGTH: 8,
  PASSWORD_HASH_ROUNDS: 300,
  MAX_LOGIN_ATTEMPTS: 5,                               // Failed attempts before a temporary lockout
  LOGIN_LOCKOUT_SECONDS: 600                           // 10 minutes
});

/** Default academic calendar (months are 1–12). Admins change this in Configuration → Academic Calendar. */
const DEFAULT_CALENDAR = Object.freeze({ sem1Start: 8, sem1End: 12, sem2Start: 1, sem2End: 5 });

const SHEET_NAMES = Object.freeze({
  LOGS: 'Violation_Logs',
  SETTINGS: 'System_Settings',
  USERS: 'Authorized_Users',
  AUDIT: 'Audit_Log',
  CONFERENCES: 'Parent_Conferences'
});

const LOG_HEADERS = [
  'log_id', 'timestamp', 'student_id', 'student_name', 'section', 'infraction',
  'severity', 'frequency', 'sanction', 'remarks', 'evidence_link', 'report_pdf_link',
  'remark_status'
];
const SETTING_HEADERS = ['setting_id', 'category', 'value', 'is_active'];
const USER_HEADERS = ['user_id', 'username', 'display_name', 'role', 'password_hash', 'salt', 'is_active', 'created_at', 'last_login'];
const AUDIT_HEADERS = ['audit_id', 'timestamp', 'username', 'role', 'action', 'entity', 'entity_id', 'details'];
const CONFERENCE_HEADERS = [
  'conference_id', 'student_id', 'student_name', 'section', 'conference_date', 'status',
  'guardian_name', 'notes', 'outcome', 'recorded_by', 'created_at', 'updated_at'
];

const SHEET_HEADERS = {};
SHEET_HEADERS[SHEET_NAMES.LOGS] = LOG_HEADERS;
SHEET_HEADERS[SHEET_NAMES.SETTINGS] = SETTING_HEADERS;
SHEET_HEADERS[SHEET_NAMES.USERS] = USER_HEADERS;
SHEET_HEADERS[SHEET_NAMES.AUDIT] = AUDIT_HEADERS;
SHEET_HEADERS[SHEET_NAMES.CONFERENCES] = CONFERENCE_HEADERS;

const SETTING_CATEGORIES = ['Infractions', 'Severity Levels', 'Frequencies', 'Sanctions', 'Remarks'];
const ROLES = ['Admin', 'Staff'];
const CONFERENCE_STATUSES = ['Scheduled', 'Held', 'Rescheduled', 'Cancelled', 'No-show'];

const ALLOWED_UPLOAD_TYPES = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
  'image/heic', 'image/heif', 'application/pdf'
];

const FIELD_LIMITS = Object.freeze({
  student_id: 50,
  student_name: 120,
  section: 80,
  infraction: 120,
  severity: 60,
  sanction: 120,
  remarks: 2000,
  remark_status: 80,
  evidence_link: 500,
  setting_value: 120,
  username: 30,
  display_name: 60,
  guardian_name: 120,
  notes: 2000,
  outcome: 1000
});

const PROP_KEYS = Object.freeze({
  EVIDENCE_FOLDER: 'CS_EVIDENCE_FOLDER_ID',
  REPORTS_FOLDER: 'CS_REPORTS_FOLDER_ID',
  TEMPLATE_DOC: 'CS_TEMPLATE_DOC_ID',
  CALENDAR: 'DART_ACADEMIC_CALENDAR',
  SETUP_KEY: 'DART_SETUP_KEY'
});

const ESCALATION_MESSAGE = 'Threshold Reached: Recommend Parent Conference.';

const DEFAULT_SETTINGS = Object.freeze({
  'Infractions': ['Tardiness', 'Improper Uniform', 'Cutting Classes', 'Disrespect to Authority', 'Use of Mobile Phone in Class', 'Bullying', 'Academic Dishonesty', 'Vandalism'],
  'Severity Levels': ['Minor', 'Major', 'Grave'],
  'Frequencies': ['1st Offense', '2nd Offense', '3rd Offense', '4th Offense', '5th Offense'],
  'Sanctions': ['Verbal Warning', 'Written Warning', 'Parent Conference', 'Community Service', 'Suspension'],
  'Remarks': ['Pending', 'Under Investigation', 'Adjudicated', 'Resolved']
});

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Data Privacy Notice shown on the sign-in screen and in the app. Edit the wording here if needed. */
const PRIVACY_NOTICE = [
  'DEMO NOTICE: This is a public portfolio demo. The school, students, guardians and incidents shown here are entirely fictional and were generated automatically. Please do not enter real personal information — the demo data is reset every night.',
  'In a real deployment, DART is used by the ' + CONFIG.DEPARTMENT_NAME + ' of the ' + CONFIG.SCHOOL_NAME + ' to record and manage student disciplinary cases, in line with Republic Act No. 10173 (Data Privacy Act of 2012) and its Implementing Rules and Regulations.',
  'Personal information processed: student ID, name, section and grade level; incident details, sanctions and remarks; uploaded evidence; and parent/guardian conference records.',
  'Purpose: to document incidents fairly and accurately, apply the student handbook consistently, identify students who need intervention, and coordinate with parents or guardians.',
  'Access is limited to authorized school personnel with individual DART accounts. Every action (sign-in, creation, edit, deletion, report and export) is recorded in an audit log.',
  'Records are stored in the school\'s Google Workspace (Sheets and Drive) and are kept only as long as required by school policy and applicable regulations.',
  'Data subjects may exercise their rights to be informed, to access, to correct, and to object, among others, through the SHS Department office or the school\'s Data Protection Officer.',
  'Authorized users must keep student information confidential, must not share their passwords, and must use the data only for official school purposes.'
];

/** Every browser-callable data action and the minimum role it requires. */
const API_ACTIONS = {
  bootstrap: { fn: bootstrap_, role: 'Staff' },
  getSettings: { fn: getSettings_, role: 'Admin' },
  addSetting: { fn: addSetting_, role: 'Admin' },
  updateSetting: { fn: updateSetting_, role: 'Admin' },
  deleteSetting: { fn: deleteSetting_, role: 'Admin' },
  getCalendar: { fn: getCalendarInfo_, role: 'Staff' },
  saveCalendar: { fn: saveCalendar_, role: 'Admin' },
  calculateFrequency: { fn: calculateFrequency_, role: 'Staff' },
  insertViolation: { fn: insertViolation_, role: 'Staff' },
  getViolations: { fn: getViolations_, role: 'Staff' },
  getViolationById: { fn: getViolationById_, role: 'Staff' },
  updateViolation: { fn: updateViolation_, role: 'Staff' },
  deleteViolation: { fn: deleteViolation_, role: 'Admin' },
  getStudentDirectory: { fn: getStudentDirectory_, role: 'Staff' },
  getEscalationWatchlist: { fn: getEscalationWatchlist_, role: 'Staff' },
  getStudentHistory: { fn: getStudentHistory_, role: 'Staff' },
  generatePDFReport: { fn: generatePDFReport_, role: 'Staff' },
  getDashboardStats: { fn: getDashboardStats_, role: 'Staff' },
  exportViolationsCsv: { fn: exportViolationsCsv_, role: 'Staff' },
  generateSummaryReport: { fn: generateSummaryReport_, role: 'Staff' },
  listConferences: { fn: listConferences_, role: 'Staff' },
  saveConference: { fn: saveConference_, role: 'Staff' },
  deleteConference: { fn: deleteConference_, role: 'Admin' },
  listUsers: { fn: listUsers_, role: 'Admin' },
  addUser: { fn: addUser_, role: 'Admin' },
  updateUser: { fn: updateUser_, role: 'Admin' },
  resetUserPassword: { fn: resetUserPassword_, role: 'Admin' },
  deleteUser: { fn: deleteUser_, role: 'Admin' },
  changeOwnPassword: { fn: changeOwnPassword_, role: 'Staff' },
  getAuditLog: { fn: getAuditLog_, role: 'Admin' }
};

/** The signed-in user for the current request (set by apiCall). */
let CURRENT_USER_ = null;

// ============================================================================
// 2. WEB APP ENTRY POINTS (browser-callable)
// ============================================================================

function doGet(e) {
  try {
    const template = HtmlService.createTemplateFromFile('Index');
    template.logoUrl = getLogoDataUrl_();
    template.adminMode = !!(e && e.parameter && String(e.parameter.admin) === '1');
    let appUrl = '';
    try { appUrl = ScriptApp.getService().getUrl() || ''; } catch (err) { appUrl = ''; }
    template.appUrl = appUrl;
    return template
      .evaluate()
      .setTitle(CONFIG.APP_TITLE)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
  } catch (err) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:Arial,sans-serif;padding:32px;max-width:640px">' +
      '<h2 style="color:#1e40af">DART — Disciplinary Action &amp; Resolution Tracker</h2>' +
      '<p>The backend is running, but a frontend file could not be loaded.</p>' +
      '<p style="color:#6b7280;font-size:13px">' + escapeHtml_(err.message) + '</p></div>'
    ).setTitle(CONFIG.APP_TITLE);
  }
}

/** Used by the HTML template to inline other HTML files: <?!= include('JavaScript'); ?> */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** No sign-in required: tells the login screen whether first-time setup is needed. */
function getPublicConfig() {
  const users = readUsers_();
  return {
    appShortName: CONFIG.APP_SHORT_NAME,
    schoolName: CONFIG.SCHOOL_NAME,
    departmentName: CONFIG.DEPARTMENT_NAME,
    needsSetup: users.length === 0,
    passwordMinLength: CONFIG.PASSWORD_MIN_LENGTH,
    privacyNotice: PRIVACY_NOTICE.slice(),
    demo: typeof DEMO !== 'undefined' && DEMO.ENABLED
  };
}

/**
 * No sign-in required, but only works while there are zero user accounts AND the caller
 * knows the one-time setup key (shown in the Execution log when setupDatabase() is run).
 */
function createFirstAdmin(payload) {
  const p = payload || {};
  if (typeof DEMO !== 'undefined' && DEMO.ENABLED) throw new Error('Setup is disabled in demo mode. Open ?admin=1 while signed in to the owner\'s Google account.');
  return withLock_(function () {
    if (readUsers_().length > 0) throw new Error('Setup is already complete. Please sign in.');
    const props = PropertiesService.getScriptProperties();
    const expected = props.getProperty(PROP_KEYS.SETUP_KEY);
    if (!expected) throw new Error('No setup key found. Run setupDatabase() from the Apps Script editor first — the Execution log will show the one-time setup key.');
    const normalize = function (k) { return String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); };
    if (normalize(p.setup_key) !== normalize(expected)) throw new Error('Incorrect setup key. Check the Execution log of setupDatabase().');
    const user = createUserRecord_({
      username: p.username,
      display_name: p.display_name || 'ADMIN',
      role: 'Admin',
      password: p.password
    });
    const sheet = getSheet_(SHEET_NAMES.USERS);
    const table = readTable_(sheet, USER_HEADERS);
    const loc = locateById_(table, 'user_id', user.user_id);
    if (loc) writeFields_(sheet, loc.rowNumber, table.map, { last_login: new Date() });
    user.last_login = new Date();
    props.deleteProperty(PROP_KEYS.SETUP_KEY);
    CURRENT_USER_ = user;
    audit_('FIRST_ADMIN_CREATED', 'User', user.user_id, { username: user.username });
    seedDefaultSettings_(getSheet_(SHEET_NAMES.SETTINGS));
    return startSession_(user);
  });
}

/** Signs in with username + password. Returns { token, user }. */
function login(username, password) {
  const uname = normalizeUsername_(username);
  const pwd = String(password || '');
  if (!uname || !pwd) throw new Error('Enter your username and password.');

  const cache = CacheService.getScriptCache();
  const failKey = 'fail_' + uname;
  const fails = parseInt(cache.get(failKey) || '0', 10);
  if (fails >= CONFIG.MAX_LOGIN_ATTEMPTS) {
    throw new Error('Too many failed attempts. Please wait ' + Math.round(CONFIG.LOGIN_LOCKOUT_SECONDS / 60) + ' minutes and try again.');
  }

  const users = readUsers_();
  let match = null;
  for (let i = 0; i < users.length; i++) {
    if (users[i].username === uname) { match = users[i]; break; }
  }

  const valid = match && match.is_active && match.password_hash && hashPassword_(pwd, match.salt) === match.password_hash;
  if (!valid) {
    cache.put(failKey, String(fails + 1), CONFIG.LOGIN_LOCKOUT_SECONDS);
    CURRENT_USER_ = null;
    audit_('LOGIN_FAILED', 'Session', uname, { reason: !match ? 'unknown username' : (!match.is_active ? 'inactive account' : 'wrong password') });
    throw new Error('Incorrect username or password.');
  }

  cache.remove(failKey);
  CURRENT_USER_ = match;
  withLock_(function () {
    const sheet = getSheet_(SHEET_NAMES.USERS);
    const table = readTable_(sheet, USER_HEADERS);
    const loc = locateById_(table, 'user_id', match.user_id);
    if (loc) writeFields_(sheet, loc.rowNumber, table.map, { last_login: new Date() });
  });
  audit_('LOGIN', 'Session', match.user_id, {});
  return startSession_(match);
}

function logout(token) {
  const key = 'sess_' + String(token || '');
  const cache = CacheService.getScriptCache();
  const raw = cache.get(key);
  if (raw) {
    try {
      const s = JSON.parse(raw);
      CURRENT_USER_ = findUserById_(s.user_id);
      audit_('LOGOUT', 'Session', s.user_id, {});
    } catch (e) { /* ignore */ }
    cache.remove(key);
  }
  return { success: true };
}

/** Single gateway for every data action. Validates the session and role first. */
function apiCall(token, action, args) {
  const user = requireSession_(token);
  const def = API_ACTIONS[action];
  if (!def) throw new Error('Unknown action: ' + action);
  if (def.role === 'Admin' && user.role !== 'Admin') {
    throw new Error('Permission denied: only Admin accounts can do this.');
  }
  CURRENT_USER_ = user;
  if (typeof demoGuard_ === 'function') demoGuard_(user, action, args, String(token));
  return def.fn.apply(null, Array.isArray(args) ? args : []);
}

// ============================================================================
// 3. EDITOR-ONLY MAINTENANCE FUNCTIONS
// ============================================================================

function setupDatabase() {
  assertEditor_();
  const ss = getSpreadsheet_();
  Object.keys(SHEET_HEADERS).forEach(function (name) { ensureSheet_(ss, name, SHEET_HEADERS[name]); });

  const logs = ss.getSheetByName(SHEET_NAMES.LOGS);
  const logMap = getHeaderMap_(logs, LOG_HEADERS).map;
  if (logs.getMaxRows() > 1) {
    logs.getRange(2, logMap.timestamp + 1, logs.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  }

  const seeded = seedDefaultSettings_(ss.getSheetByName(SHEET_NAMES.SETTINGS));
  const evidenceFolder = getOrCreateFolder_(PROP_KEYS.EVIDENCE_FOLDER, CONFIG.EVIDENCE_FOLDER_NAME);
  const reportsFolder = getOrCreateFolder_(PROP_KEYS.REPORTS_FOLDER, CONFIG.REPORTS_FOLDER_NAME);
  const userCount = readUsers_().length;

  let setupKeyLine = '';
  if (userCount === 0) {
    const props = PropertiesService.getScriptProperties();
    let key = props.getProperty(PROP_KEYS.SETUP_KEY);
    if (!key) {
      const raw = Utilities.getUuid().replace(/[^a-fA-F0-9]/g, '').toUpperCase().slice(0, 8);
      key = raw.slice(0, 4) + '-' + raw.slice(4);
      props.setProperty(PROP_KEYS.SETUP_KEY, key);
    }
    setupKeyLine = '>>> ONE-TIME SETUP KEY: ' + key + '  (enter this on the web app\'s "Set up DART" screen)';
  }

  const msg = [
    'DART setup complete.',
    'Sheets verified: ' + Object.keys(SHEET_HEADERS).join(', '),
    'Default settings seeded: ' + seeded,
    'User accounts: ' + userCount + (userCount === 0 ? ' (open the web app to create the first Admin account)' : ''),
    'Evidence folder: ' + evidenceFolder.getUrl(),
    'Reports folder: ' + reportsFolder.getUrl()
  ].concat(setupKeyLine ? ['', setupKeyLine] : []).join('\n');
  Logger.log(msg);
  return msg;
}

/**
 * Emergency access recovery. Edit USERNAME and NEW_PASSWORD below, run it from the editor,
 * then sign in and change the password immediately. Creates the account if it doesn't exist.
 */
function emergencyResetPassword() {
  assertEditor_();
  const USERNAME = 'admin';
  const NEW_PASSWORD = 'ChangeMe123!';

  const uname = normalizeUsername_(USERNAME);
  const result = withLock_(function () {
    const sheet = getSheet_(SHEET_NAMES.USERS);
    const table = readTable_(sheet, USER_HEADERS);
    let rowNumber = 0;
    let userId = '';
    table.rows.forEach(function (r, i) {
      if (normalizeUsername_(r[table.map.username]) === uname) { rowNumber = i + 2; userId = String(r[table.map.user_id]).trim(); }
    });
    if (!rowNumber) {
      const created = createUserRecord_({ username: uname, display_name: 'ADMIN', role: 'Admin', password: NEW_PASSWORD });
      return 'Created Admin account "' + created.username + '".';
    }
    validatePassword_(NEW_PASSWORD);
    const salt = newSalt_();
    writeFields_(sheet, rowNumber, table.map, {
      password_hash: hashPassword_(NEW_PASSWORD, salt), salt: salt, is_active: true, role: 'Admin'
    });
    CacheService.getScriptCache().remove('fail_' + uname);
    CURRENT_USER_ = null;
    audit_('PASSWORD_RESET', 'User', userId, { via: 'emergencyResetPassword (editor)' });
    return 'Password reset and Admin access restored for "' + uname + '".';
  });
  Logger.log(result + ' Sign in, then change the password right away.');
  return result;
}

/**
 * OWNERSHIP HANDOVER — run this ONCE from the NEW owner's account (Apps Script editor),
 * after the spreadsheet has been transferred to them.
 * Creates new "DART - Evidence" / "DART - Reports" folders and a new incident report template
 * in the new owner's Google Drive, so every NEW upload, Doc and PDF is created under their account.
 * Existing records, users, settings and the academic calendar are kept. Old files/links are not touched.
 */
function handOverToNewOwner() {
  assertEditor_();
  const me = Session.getEffectiveUser().getEmail();
  const props = PropertiesService.getScriptProperties();

  const evidence = DriveApp.createFolder(CONFIG.EVIDENCE_FOLDER_NAME);
  const reports = DriveApp.createFolder(CONFIG.REPORTS_FOLDER_NAME);
  props.setProperty(PROP_KEYS.EVIDENCE_FOLDER, evidence.getId());
  props.setProperty(PROP_KEYS.REPORTS_FOLDER, reports.getId());

  const templateId = createSampleTemplate();

  CURRENT_USER_ = null;
  audit_('UPDATE', 'System', 'ownership', { new_owner: me, evidence_folder: evidence.getId(), reports_folder: reports.getId(), template: templateId });

  const msg = [
    'DART handover complete. New files will now be created in the Drive of: ' + me,
    'Evidence folder: ' + evidence.getUrl(),
    'Reports folder: ' + reports.getUrl(),
    'Report template: https://docs.google.com/document/d/' + templateId + '/edit',
    '',
    'NEXT: Deploy > New deployment > Web app > Execute as: Me (' + me + ') > Deploy.',
    'Share the NEW web app URL with users. The previous owner should archive their old deployment.'
  ].join('\n');
  Logger.log(msg);
  return msg;
}

/** Shows which Google account DART is currently running as (run from the editor). */
function whoOwnsDart() {
  const me = Session.getEffectiveUser().getEmail();
  const props = PropertiesService.getScriptProperties();
  const describe = function (key, label) {
    const id = props.getProperty(key);
    if (!id) return label + ': not set';
    try {
      const f = key === PROP_KEYS.TEMPLATE_DOC ? DriveApp.getFileById(id) : DriveApp.getFolderById(id);
      return label + ': owned by ' + (f.getOwner() ? f.getOwner().getEmail() : 'unknown') + ' — ' + f.getUrl();
    } catch (e) {
      return label + ': NOT ACCESSIBLE from this account (run handOverToNewOwner())';
    }
  };
  const msg = [
    'Running as: ' + me,
    describe(PROP_KEYS.EVIDENCE_FOLDER, 'Evidence folder'),
    describe(PROP_KEYS.REPORTS_FOLDER, 'Reports folder'),
    describe(PROP_KEYS.TEMPLATE_DOC, 'Report template'),
    'Spreadsheet owner: ' + (function () { try { return DriveApp.getFileById(getSpreadsheet_().getId()).getOwner().getEmail(); } catch (e) { return 'unknown'; } })()
  ].join('\n');
  Logger.log(msg);
  return msg;
}

/** Only the script owner running from the Apps Script editor may call maintenance functions. */
function assertEditor_() {
  let active = '';
  let effective = '';
  try { active = Session.getActiveUser().getEmail(); } catch (e) { active = ''; }
  try { effective = Session.getEffectiveUser().getEmail(); } catch (e) { effective = ''; }
  if (!active || active !== effective) {
    throw new Error('This function can only be run by the script owner from the Apps Script editor.');
  }
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);

  if (sheet.getLastColumn() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    const existing = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function (h) {
      return String(h).trim();
    });
    const missing = headers.filter(function (h) { return existing.indexOf(h) === -1; });
    if (missing.length) {
      sheet.getRange(1, sheet.getLastColumn() + 1, 1, missing.length).setValues([missing]);
    }
  }

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .setFontWeight('bold')
    .setBackground('#1e40af')
    .setFontColor('#ffffff');
  return sheet;
}

/** Seeds default options only for categories that currently have no rows (safe to re-run). */
function seedDefaultSettings_(sheet) {
  const table = readTable_(sheet, SETTING_HEADERS);
  const usedCategories = {};
  table.rows.forEach(function (r) {
    if (String(r[table.map.setting_id]).trim()) usedCategories[normalizeKey_(r[table.map.category])] = true;
  });
  const records = [];
  SETTING_CATEGORIES.forEach(function (category) {
    if (usedCategories[normalizeKey_(category)]) return;
    (DEFAULT_SETTINGS[category] || []).forEach(function (value) {
      records.push({ setting_id: generateId_('SET'), category: category, value: value, is_active: true });
    });
  });
  if (!records.length) return 0;

  const startRow = Math.max(sheet.getLastRow(), 1) + 1;
  sheet.getRange(startRow, table.map.is_active + 1, records.length, 1).insertCheckboxes();

  const values = records.map(function (rec) {
    const row = new Array(table.width).fill('');
    SETTING_HEADERS.forEach(function (h) { row[table.map[h]] = sanitizeCell_(rec[h]); });
    return row;
  });
  sheet.getRange(startRow, 1, values.length, table.width).setValues(values);
  SpreadsheetApp.flush();
  return records.length;
}

// ============================================================================
// 4. AUTHENTICATION, SESSIONS & USERS
// ============================================================================

function normalizeUsername_(value) {
  return String(value === undefined || value === null ? '' : value).trim().toLowerCase();
}

function newSalt_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
}

function hashPassword_(password, salt) {
  let bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(salt) + '|' + String(password), Utilities.Charset.UTF_8);
  for (let i = 1; i < CONFIG.PASSWORD_HASH_ROUNDS; i++) {
    bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.base64Encode(bytes) + '|' + String(salt), Utilities.Charset.UTF_8);
  }
  return Utilities.base64Encode(bytes);
}

function validatePassword_(password) {
  const p = String(password || '');
  if (p.length < CONFIG.PASSWORD_MIN_LENGTH) throw new Error('Password must be at least ' + CONFIG.PASSWORD_MIN_LENGTH + ' characters.');
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) throw new Error('Password must contain at least one letter and one number.');
  return p;
}

function validateUsername_(username) {
  const u = normalizeUsername_(username);
  if (!/^[a-z0-9._-]{3,30}$/.test(u)) throw new Error('Username must be 3–30 characters: letters, numbers, dot, dash or underscore.');
  return u;
}

function readUsers_() {
  const table = readTable_(getSheet_(SHEET_NAMES.USERS), USER_HEADERS);
  const m = table.map;
  return table.rows
    .filter(function (r) { return String(r[m.user_id]).trim() !== ''; })
    .map(function (r) {
      return {
        user_id: String(r[m.user_id]).trim(),
        username: normalizeUsername_(r[m.username]),
        display_name: String(r[m.display_name]).trim(),
        role: ROLES.indexOf(String(r[m.role]).trim()) !== -1 ? String(r[m.role]).trim() : 'Staff',
        password_hash: String(r[m.password_hash]).trim(),
        salt: String(r[m.salt]).trim(),
        is_active: toBool_(r[m.is_active]),
        created_at: r[m.created_at],
        last_login: r[m.last_login]
      };
    });
}

function findUserById_(userId) {
  const users = readUsers_();
  for (let i = 0; i < users.length; i++) if (users[i].user_id === userId) return users[i];
  return null;
}

function publicUser_(u) {
  const created = parseDate_(u.created_at);
  const last = parseDate_(u.last_login);
  return {
    user_id: u.user_id,
    username: u.username,
    display_name: u.display_name || u.username.toUpperCase(),
    role: u.role,
    is_active: u.is_active,
    created_at_display: created ? formatDate_(created, 'MMM d, yyyy') : '',
    last_login_display: last ? formatDate_(last, 'MMM d, yyyy h:mm a') : 'Never'
  };
}

/** Creates a user row. Must be called inside withLock_. */
function createUserRecord_(p) {
  const username = validateUsername_(p.username);
  const password = validatePassword_(p.password);
  const role = ROLES.indexOf(p.role) !== -1 ? p.role : 'Staff';
  const displayName = cleanText_(p.display_name, FIELD_LIMITS.display_name) || username.toUpperCase();
  const sheet = getSheet_(SHEET_NAMES.USERS);
  const table = readTable_(sheet, USER_HEADERS);
  table.rows.forEach(function (r) {
    if (normalizeUsername_(r[table.map.username]) === username) throw new Error('The username "' + username + '" is already taken.');
  });
  const salt = newSalt_();
  const record = {
    user_id: generateUniqueId_('USR', table, 'user_id'),
    username: username,
    display_name: displayName,
    role: role,
    password_hash: hashPassword_(password, salt),
    salt: salt,
    is_active: true,
    created_at: new Date(),
    last_login: ''
  };
  appendRecord_(sheet, table, USER_HEADERS, record, { checkboxColumns: ['is_active'] });
  return record;
}

function startSession_(user) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify({ user_id: user.user_id }), CONFIG.SESSION_TTL_SECONDS);
  return { token: token, user: publicUser_(user) };
}

function authError_(msg) {
  return new Error('AUTH_REQUIRED: ' + (msg || 'Your session has expired. Please sign in again.'));
}

function requireSession_(token) {
  const t = String(token || '');
  if (!/^[a-f0-9]{64}$/.test(t)) throw authError_('Please sign in to continue.');
  const cache = CacheService.getScriptCache();
  const raw = cache.get('sess_' + t);
  if (!raw) throw authError_();
  let s;
  try { s = JSON.parse(raw); } catch (e) { throw authError_(); }
  if (s && s.virtual) {                       // password-less demo session (Demo.gs)
    if (typeof DEMO === 'undefined' || !DEMO.ENABLED) { cache.remove('sess_' + t); throw authError_(); }
    cache.put('sess_' + t, raw, CONFIG.SESSION_TTL_SECONDS);
    return virtualUser_(s);
  }
  const user = findUserById_(s.user_id);
  if (!user || !user.is_active) {
    cache.remove('sess_' + t);
    throw authError_('Your account is inactive or was removed. Contact an Admin.');
  }
  cache.put('sess_' + t, raw, CONFIG.SESSION_TTL_SECONDS);
  return user;
}

function actorName_() {
  if (!CURRENT_USER_) return 'system';
  return (CURRENT_USER_.display_name || CURRENT_USER_.username) + ' (' + CURRENT_USER_.username + ')';
}

function listUsers_() {
  return readUsers_().map(publicUser_).sort(function (a, b) {
    return a.role === b.role ? a.username.localeCompare(b.username) : (a.role === 'Admin' ? -1 : 1);
  });
}

/** payload: { username, display_name, role, password } */
function addUser_(payload) {
  const p = payload || {};
  return withLock_(function () {
    const record = createUserRecord_(p);
    audit_('CREATE', 'User', record.user_id, { username: record.username, role: record.role });
    return { success: true, message: 'Account "' + record.username + '" created.', user: publicUser_(record) };
  });
}

/** payload: { user_id, display_name?, role?, is_active? } */
function updateUser_(payload) {
  const p = payload || {};
  const id = cleanText_(p.user_id, 100);
  if (!id) throw new Error('user_id is required.');
  return withLock_(function () {
    const sheet = getSheet_(SHEET_NAMES.USERS);
    const table = readTable_(sheet, USER_HEADERS);
    const loc = locateById_(table, 'user_id', id);
    if (!loc) throw new Error('Account not found.');
    const current = rowToObject_(loc.row, table.map, USER_HEADERS);
    const updates = {};
    if (p.display_name !== undefined) {
      const dn = cleanText_(p.display_name, FIELD_LIMITS.display_name);
      if (!dn) throw new Error('Display name cannot be empty.');
      updates.display_name = dn;
    }
    if (p.role !== undefined) {
      if (ROLES.indexOf(p.role) === -1) throw new Error('Invalid role.');
      updates.role = p.role;
    }
    if (p.is_active !== undefined) updates.is_active = toBool_(p.is_active);

    const isSelf = CURRENT_USER_ && CURRENT_USER_.user_id === id;
    if (isSelf && (updates.is_active === false || updates.role === 'Staff')) {
      throw new Error('You cannot deactivate or demote your own account.');
    }
    const losingAdmin = String(current.role).trim() === 'Admin' && toBool_(current.is_active) &&
      (updates.is_active === false || updates.role === 'Staff');
    if (losingAdmin && countActiveAdmins_(table) <= 1) throw new Error('At least one active Admin account is required.');

    writeFields_(sheet, loc.rowNumber, table.map, updates);
    audit_('UPDATE', 'User', id, diffFields_(current, updates, ['display_name', 'role', 'is_active']));
    const merged = readUsers_().filter(function (u) { return u.user_id === id; })[0];
    return { success: true, message: 'Account updated.', user: publicUser_(merged) };
  });
}

function resetUserPassword_(userId, newPassword) {
  const id = cleanText_(userId, 100);
  const pwd = validatePassword_(newPassword);
  return withLock_(function () {
    const sheet = getSheet_(SHEET_NAMES.USERS);
    const table = readTable_(sheet, USER_HEADERS);
    const loc = locateById_(table, 'user_id', id);
    if (!loc) throw new Error('Account not found.');
    const salt = newSalt_();
    writeFields_(sheet, loc.rowNumber, table.map, { password_hash: hashPassword_(pwd, salt), salt: salt });
    CacheService.getScriptCache().remove('fail_' + normalizeUsername_(loc.row[table.map.username]));
    audit_('PASSWORD_RESET', 'User', id, { username: normalizeUsername_(loc.row[table.map.username]) });
    return { success: true, message: 'Password reset. Share the new password with the user privately.' };
  });
}

function deleteUser_(userId) {
  const id = cleanText_(userId, 100);
  if (CURRENT_USER_ && CURRENT_USER_.user_id === id) throw new Error('You cannot delete your own account.');
  return withLock_(function () {
    const sheet = getSheet_(SHEET_NAMES.USERS);
    const table = readTable_(sheet, USER_HEADERS);
    const loc = locateById_(table, 'user_id', id);
    if (!loc) throw new Error('Account not found.');
    const isActiveAdmin = String(loc.row[table.map.role]).trim() === 'Admin' && toBool_(loc.row[table.map.is_active]);
    if (isActiveAdmin && countActiveAdmins_(table) <= 1) throw new Error('At least one active Admin account is required.');
    const uname = normalizeUsername_(loc.row[table.map.username]);
    sheet.deleteRow(loc.rowNumber);
    audit_('DELETE', 'User', id, { username: uname });
    return { success: true, message: 'Account "' + uname + '" deleted.' };
  });
}

function changeOwnPassword_(currentPassword, newPassword) {
  const me = CURRENT_USER_;
  if (!me) throw authError_();
  if (hashPassword_(String(currentPassword || ''), me.salt) !== me.password_hash) throw new Error('Your current password is incorrect.');
  const pwd = validatePassword_(newPassword);
  return withLock_(function () {
    const sheet = getSheet_(SHEET_NAMES.USERS);
    const table = readTable_(sheet, USER_HEADERS);
    const loc = locateById_(table, 'user_id', me.user_id);
    if (!loc) throw new Error('Account not found.');
    const salt = newSalt_();
    writeFields_(sheet, loc.rowNumber, table.map, { password_hash: hashPassword_(pwd, salt), salt: salt });
    audit_('PASSWORD_CHANGE', 'User', me.user_id, {});
    return { success: true, message: 'Your password has been changed.' };
  });
}

function countActiveAdmins_(table) {
  return table.rows.filter(function (r) {
    return String(r[table.map.user_id]).trim() && String(r[table.map.role]).trim() === 'Admin' && toBool_(r[table.map.is_active]);
  }).length;
}

// ============================================================================
// 5. AUDIT LOG
// ============================================================================

/** Appends an audit entry. Never throws — auditing must not break the main action. */
function audit_(action, entity, entityId, details) {
  try {
    const sheet = getSheet_(SHEET_NAMES.AUDIT);
    const header = getHeaderMap_(sheet, AUDIT_HEADERS);
    let detailText = '';
    if (details && typeof details === 'object' && Object.keys(details).length) detailText = JSON.stringify(details);
    else if (typeof details === 'string') detailText = details;
    if (detailText.length > 2000) detailText = detailText.slice(0, 1997) + '...';
    const record = {
      audit_id: generateId_('AUD'),
      timestamp: new Date(),
      username: CURRENT_USER_ ? CURRENT_USER_.username : 'anonymous',
      role: CURRENT_USER_ ? CURRENT_USER_.role : '',
      action: action,
      entity: entity,
      entity_id: String(entityId || ''),
      details: detailText
    };
    const row = new Array(header.width).fill('');
    AUDIT_HEADERS.forEach(function (h) { row[header.map[h]] = sanitizeCell_(record[h]); });
    sheet.appendRow(row);
  } catch (e) {
    Logger.log('Audit write failed: ' + e.message);
  }
}

/** Returns { field: [old, new] } for fields that changed. */
function diffFields_(before, updates, fields) {
  const out = {};
  fields.forEach(function (f) {
    if (updates[f] === undefined) return;
    const oldVal = before[f] instanceof Date ? before[f].toISOString() : String(before[f] === undefined || before[f] === null ? '' : before[f]).trim();
    const newVal = updates[f] instanceof Date ? updates[f].toISOString() : String(updates[f]).trim();
    if (oldVal !== newVal) out[f] = [oldVal.slice(0, 200), newVal.slice(0, 200)];
  });
  return out;
}

/** opts: { search?, action?, limit? } — newest first. */
function getAuditLog_(opts) {
  const o = opts || {};
  const limit = Math.min(Math.max(parseInt(o.limit, 10) || 1000, 1), 3000);
  const q = normalizeKey_(o.search);
  const actionFilter = normalizeKey_(o.action);
  const table = readTable_(getSheet_(SHEET_NAMES.AUDIT), AUDIT_HEADERS);
  const m = table.map;
  const out = [];
  for (let i = table.rows.length - 1; i >= 0 && out.length < limit; i--) {
    const r = table.rows[i];
    if (!String(r[m.audit_id]).trim()) continue;
    const rec = rowToObject_(r, m, AUDIT_HEADERS);
    if (actionFilter && normalizeKey_(rec.action) !== actionFilter) continue;
    if (q && normalizeKey_([rec.username, rec.action, rec.entity, rec.entity_id, rec.details].join(' ')).indexOf(q) === -1) continue;
    const d = parseDate_(rec.timestamp);
    out.push({
      audit_id: String(rec.audit_id),
      timestamp: d ? d.toISOString() : '',
      timestamp_display: d ? formatDate_(d, 'MMM d, yyyy h:mm:ss a') : '',
      username: String(rec.username || ''),
      role: String(rec.role || ''),
      action: String(rec.action || ''),
      entity: String(rec.entity || ''),
      entity_id: String(rec.entity_id || ''),
      details: String(rec.details || '')
    });
  }
  return out;
}

// ============================================================================
// 6. BOOTSTRAP & ACADEMIC CALENDAR
// ============================================================================

function bootstrap_() {
  return {
    appTitle: CONFIG.APP_TITLE,
    appShortName: CONFIG.APP_SHORT_NAME,
    user: publicUser_(CURRENT_USER_),
    settings: getSettingsGrouped_(false),
    categories: SETTING_CATEGORIES.slice(),
    timeFilters: getTimeFilters_(),
    calendar: getCalendarInfo_(),
    conferenceStatuses: CONFERENCE_STATUSES.slice(),
    roles: ROLES.slice(),
    escalationThreshold: CONFIG.ESCALATION_THRESHOLD,
    escalationMessage: ESCALATION_MESSAGE,
    schoolName: CONFIG.SCHOOL_NAME,
    departmentName: CONFIG.DEPARTMENT_NAME,
    passwordMinLength: CONFIG.PASSWORD_MIN_LENGTH,
    privacyNotice: PRIVACY_NOTICE.slice(),
    timezone: Session.getScriptTimeZone(),
    demo: typeof demoInfo_ === 'function' ? demoInfo_() : null
  };
}

function getTimeFilters_() {
  const keys = ['ALL', 'TODAY', 'WEEK', 'MONTH', 'SEM1', 'SEM2', 'ACADEMIC_YEAR'];
  return keys.map(function (k) {
    const r = getDateRange_(k);
    return { key: k, label: r.shortLabel || r.label };
  });
}

function getCalendar_() {
  let cal = null;
  try { cal = JSON.parse(PropertiesService.getScriptProperties().getProperty(PROP_KEYS.CALENDAR) || 'null'); } catch (e) { cal = null; }
  const out = {};
  ['sem1Start', 'sem1End', 'sem2Start', 'sem2End'].forEach(function (k) {
    const v = cal ? parseInt(cal[k], 10) : NaN;
    out[k] = v >= 1 && v <= 12 ? v : DEFAULT_CALENDAR[k];
  });
  return out;
}

/** Returns the calendar plus human-readable current ranges. */
function getCalendarInfo_() {
  const cal = getCalendar_();
  const r = getAcademicRanges_(new Date());
  return {
    sem1Start: cal.sem1Start,
    sem1End: cal.sem1End,
    sem2Start: cal.sem2Start,
    sem2End: cal.sem2End,
    monthNames: MONTH_NAMES.slice(),
    academicYearLabel: r.label,
    sem1Range: formatDate_(r.sem1.start, 'MMM d, yyyy') + ' – ' + formatDate_(new Date(r.sem1.end.getTime() - 86400000), 'MMM d, yyyy'),
    sem2Range: formatDate_(r.sem2.start, 'MMM d, yyyy') + ' – ' + formatDate_(new Date(r.sem2.end.getTime() - 86400000), 'MMM d, yyyy')
  };
}

/** payload: { sem1Start, sem1End, sem2Start, sem2End } (months 1–12) */
function saveCalendar_(payload) {
  const p = payload || {};
  const cal = {};
  ['sem1Start', 'sem1End', 'sem2Start', 'sem2End'].forEach(function (k) {
    const v = parseInt(p[k], 10);
    if (!(v >= 1 && v <= 12)) throw new Error('Please choose a valid month for every semester field.');
    cal[k] = v;
  });
  const rel = function (m) { return (m - cal.sem1Start + 12) % 12; };
  if (!(rel(cal.sem1End) < rel(cal.sem2Start) && rel(cal.sem2Start) <= rel(cal.sem2End))) {
    throw new Error('Semesters must be in order: 1st Semester start → 1st Semester end → 2nd Semester start → 2nd Semester end, all within 12 months.');
  }
  const before = getCalendar_();
  PropertiesService.getScriptProperties().setProperty(PROP_KEYS.CALENDAR, JSON.stringify(cal));
  audit_('UPDATE', 'Calendar', 'academic_calendar', diffFields_(before, cal, ['sem1Start', 'sem1End', 'sem2Start', 'sem2End']));
  return { success: true, message: 'Academic calendar saved.', calendar: getCalendarInfo_(), timeFilters: getTimeFilters_() };
}

/** Computes the academic year that contains (or most recently started before) refDate. */
function getAcademicRanges_(refDate) {
  const cal = getCalendar_();
  const now = refDate || new Date();
  const s1 = cal.sem1Start - 1;
  const y = now.getMonth() >= s1 ? now.getFullYear() : now.getFullYear() - 1;
  const yearFor = function (m0) { return y + (m0 < s1 ? 1 : 0); };
  const monthStart = function (m1) { const m0 = m1 - 1; return new Date(yearFor(m0), m0, 1); };
  const monthEndExclusive = function (m1) { const m0 = m1 - 1; return new Date(yearFor(m0), m0 + 1, 1); };
  const sem1 = { start: monthStart(cal.sem1Start), end: monthEndExclusive(cal.sem1End) };
  const sem2 = { start: monthStart(cal.sem2Start), end: monthEndExclusive(cal.sem2End) };
  return { year: y, label: 'A.Y. ' + y + '–' + (y + 1), sem1: sem1, sem2: sem2, ay: { start: sem1.start, end: sem2.end } };
}

/** filter: ALL | TODAY | WEEK | MONTH | SEM1 | SEM2 | ACADEMIC_YEAR */
function getDateRange_(filter) {
  let key = String(filter || 'ALL').toUpperCase().trim().replace(/[\s\-]+/g, '_');
  const aliases = {
    ALL_TIME: 'ALL', THIS_WEEK: 'WEEK', THIS_MONTH: 'MONTH', AY: 'ACADEMIC_YEAR', SCHOOL_YEAR: 'ACADEMIC_YEAR',
    FIRST_SEMESTER: 'SEM1', '1ST_SEMESTER': 'SEM1', SECOND_SEMESTER: 'SEM2', '2ND_SEMESTER': 'SEM2'
  };
  if (aliases[key]) key = aliases[key];

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (key === 'TODAY') {
    return { key: key, label: 'Today (' + formatDate_(today, 'MMM d, yyyy') + ')', shortLabel: 'Today', start: today, end: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1) };
  }
  if (key === 'WEEK') {
    const offset = (today.getDay() + 6) % 7;
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    return { key: key, label: 'This Week (' + formatDate_(start, 'MMM d') + ' – ' + formatDate_(new Date(end.getTime() - 86400000), 'MMM d, yyyy') + ')', shortLabel: 'This Week', start: start, end: end };
  }
  if (key === 'MONTH') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { key: key, label: 'This Month (' + formatDate_(start, 'MMMM yyyy') + ')', shortLabel: 'This Month', start: start, end: new Date(now.getFullYear(), now.getMonth() + 1, 1) };
  }
  if (key === 'SEM1' || key === 'SEM2' || key === 'ACADEMIC_YEAR') {
    const r = getAcademicRanges_(now);
    if (key === 'SEM1') return { key: key, label: '1st Semester, ' + r.label, shortLabel: '1st Semester', start: r.sem1.start, end: r.sem1.end };
    if (key === 'SEM2') return { key: key, label: '2nd Semester, ' + r.label, shortLabel: '2nd Semester', start: r.sem2.start, end: r.sem2.end };
    return { key: key, label: 'Academic Year ' + r.label.replace('A.Y. ', ''), shortLabel: 'Academic Year', start: r.ay.start, end: r.ay.end };
  }
  return { key: 'ALL', label: 'All Time', shortLabel: 'All Time', start: null, end: null };
}

function isInRange_(value, range) {
  if (!range.start) return true;
  const d = parseDate_(value);
  if (!d) return false;
  const t = d.getTime();
  return t >= range.start.getTime() && t < range.end.getTime();
}

function rangeText_(range) {
  if (!range.start) return 'All recorded incidents';
  return formatDate_(range.start, 'MMMM d, yyyy') + ' – ' + formatDate_(new Date(range.end.getTime() - 86400000), 'MMMM d, yyyy');
}

// ============================================================================
// 7. SPREADSHEET & ID HELPERS
// ============================================================================

function getSpreadsheet_() {
  if (CONFIG.SPREADSHEET_ID) return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('No spreadsheet found. Set CONFIG.SPREADSHEET_ID or bind this script to the spreadsheet.');
  return ss;
}

/** Returns a sheet; known DART tabs are created automatically if missing. */
function getSheet_(name) {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(name);
  if (sheet) return sheet;
  if (SHEET_HEADERS[name]) return ensureSheet_(ss, name, SHEET_HEADERS[name]);
  throw new Error('Sheet "' + name + '" not found. Run setupDatabase() once from the Apps Script editor.');
}

function getHeaderMap_(sheet, requiredHeaders) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) {
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders])
      .setFontWeight('bold').setBackground('#1e40af').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    const fresh = {};
    requiredHeaders.forEach(function (h, i) { fresh[h] = i; });
    return { map: fresh, width: requiredHeaders.length };
  }
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  const map = {};
  headers.forEach(function (h, i) { if (h && !(h in map)) map[h] = i; });
  const missing = requiredHeaders.filter(function (h) { return !(h in map); });
  if (missing.length) {
    // Auto-migrate: append new columns at the end (existing data and column order are untouched).
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing])
      .setFontWeight('bold').setBackground('#1e40af').setFontColor('#ffffff');
    missing.forEach(function (h, i) { map[h] = lastCol + i; });
    SpreadsheetApp.flush();
    return { map: map, width: lastCol + missing.length };
  }
  return { map: map, width: lastCol };
}

function readTable_(sheet, requiredHeaders) {
  const header = getHeaderMap_(sheet, requiredHeaders);
  const lastRow = sheet.getLastRow();
  const rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, header.width).getValues() : [];
  return { map: header.map, width: header.width, rows: rows };
}

function rowToObject_(row, map, headers) {
  const obj = {};
  headers.forEach(function (h) { obj[h] = row[map[h]]; });
  return obj;
}

/**
 * Finds a record by its unique ID. Returns { rowNumber, row } or null.
 * Throws if the same ID appears more than once (protects against editing the wrong row).
 */
function locateById_(table, idHeader, id) {
  const target = String(id).trim();
  const col = table.map[idHeader];
  let found = null;
  for (let i = 0; i < table.rows.length; i++) {
    if (String(table.rows[i][col]).trim() === target) {
      if (found) {
        throw new Error('Data integrity error: duplicate ' + idHeader + ' "' + target + '" exists in the sheet. Resolve the duplicate before editing.');
      }
      found = { rowNumber: i + 2, row: table.rows[i] };
    }
  }
  return found;
}

function appendRecord_(sheet, table, headers, record, options) {
  const opts = options || {};
  const rowNumber = Math.max(sheet.getLastRow(), 1) + 1;
  (opts.checkboxColumns || []).forEach(function (h) {
    sheet.getRange(rowNumber, table.map[h] + 1).insertCheckboxes();
  });
  const values = new Array(table.width).fill('');
  headers.forEach(function (h) { values[table.map[h]] = sanitizeCell_(record[h]); });
  sheet.getRange(rowNumber, 1, 1, table.width).setValues([values]);
  SpreadsheetApp.flush();
  return rowNumber;
}

/** Writes only the changed cells of an already-located row. */
function writeFields_(sheet, rowNumber, map, updates) {
  Object.keys(updates).forEach(function (field) {
    if (!(field in map)) return;
    sheet.getRange(rowNumber, map[field] + 1).setValue(sanitizeCell_(updates[field]));
  });
  SpreadsheetApp.flush();
}

function generateId_(prefix) {
  const stamp = Utilities.formatDate(new Date(), 'UTC', 'yyyyMMddHHmmssSSS');
  const rand = Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase();
  return prefix + '-' + stamp + '-' + rand;
}

function generateUniqueId_(prefix, table, idHeader) {
  const col = table.map[idHeader];
  const existing = {};
  table.rows.forEach(function (r) { existing[String(r[col]).trim()] = true; });
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = generateId_(prefix);
    if (!existing[id]) return id;
    Utilities.sleep(2);
  }
  throw new Error('Could not generate a unique ID. Please try again.');
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    throw new Error('The system is busy processing another request. Please try again in a moment.');
  }
  try {
    return fn();
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

// ============================================================================
// 8. GENERAL UTILITIES
// ============================================================================

/** Forces user strings to be stored as literal text (blocks formulas and auto-conversion). */
function sanitizeCell_(value) {
  if (typeof value === 'string' && value !== '') return "'" + value;
  return value === undefined || value === null ? '' : value;
}

function cleanText_(value, maxLen) {
  if (value === undefined || value === null) return '';
  let s = String(value).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

function normalizeKey_(value) {
  return String(value === undefined || value === null ? '' : value).trim().toUpperCase().replace(/\s+/g, ' ');
}

function toBool_(value) {
  if (value === true) return true;
  if (value === false) return false;
  const s = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (s === '') return true;
  return ['true', 'yes', '1', 'active', 'y'].indexOf(s) !== -1;
}

function parseDate_(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (value === '' || value === null || value === undefined) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/** Parses "yyyy-mm-dd" as a local date (no timezone shift). */
function parseDateOnly_(value) {
  if (value instanceof Date) return value;
  const m = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  return isNaN(d.getTime()) ? null : d;
}

function formatDate_(date, pattern) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), pattern);
}

function ordinal_(n) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
}

function escapeRegex_(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sanitizeFileName_(name) {
  const cleaned = String(name || 'file').replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').slice(0, 80);
  return cleaned || 'file';
}

function countsToArray_(counts, keyName) {
  return Object.keys(counts)
    .map(function (k) { const o = {}; o[keyName] = k; o.count = counts[k]; return o; })
    .sort(function (a, b) { return b.count - a.count || String(a[keyName]).localeCompare(String(b[keyName])); });
}

function increment_(obj, key) {
  const k = key === undefined || key === null || String(key).trim() === '' ? 'Unspecified' : String(key).trim();
  obj[k] = (obj[k] || 0) + 1;
}

/**
 * Reads the grade level from a section name. Supports school section codes such as
 * "ST12A1" (strand + grade + section), "ABM11B2", "HUMSS 12-3", plus "Grade 11 - Rizal", "G12", "11-A".
 * Looks for Grade 11/12 first (SHS), then Grades 7–10.
 */
function extractGradeLevel_(section) {
  const s = String(section || '').trim();
  if (!s) return 'Unspecified';
  const explicit = s.match(/grade\s*[-:]?\s*(\d{1,2})/i);
  if (explicit) return 'Grade ' + parseInt(explicit[1], 10);
  const shs = s.match(/(?:^|[^0-9])(1[12])(?![0-9])/);
  if (shs) return 'Grade ' + shs[1];
  const jhs = s.match(/(?:^|[^0-9])(10|[7-9])(?![0-9])/);
  if (jhs) return 'Grade ' + jhs[1];
  return 'Unspecified';
}

function csvCell_(value) {
  let s = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// ============================================================================
// 9. LOGO & DRIVE HELPERS
// ============================================================================

/** Reads the logo from the "Logo" HTML file. Returns a data URL, or '' if the file is missing or invalid. */
function getLogoDataUrl_() {
  return readLogoFile_().dataUrl;
}

/** Tries common file-name variants and tolerates stray quotes, spaces or line breaks in the pasted text. */
function readLogoFile_() {
  const names = [CONFIG.LOGO_FILE_NAME, 'Logo', 'logo', 'LOGO', 'Logo.html', 'logo.html'];
  for (let i = 0; i < names.length; i++) {
    let raw;
    try {
      raw = HtmlService.createHtmlOutputFromFile(names[i]).getContent();
    } catch (e) {
      continue;
    }
    const cleaned = String(raw || '').replace(/["'`\s]/g, '');
    const idx = cleaned.indexOf('data:image/');
    let dataUrl = '';
    if (idx !== -1) {
      dataUrl = cleaned.slice(idx);
    } else if (/^[A-Za-z0-9+/=]{100,}$/.test(cleaned)) {
      dataUrl = 'data:image/png;base64,' + cleaned;
    }
    return {
      fileName: names[i],
      found: true,
      length: cleaned.length,
      dataUrl: dataUrl,
      problem: dataUrl ? '' : 'File "' + names[i] + '" was found but does not contain the logo text (it should start with data:image/png;base64,).'
    };
  }
  return { fileName: '', found: false, length: 0, dataUrl: '', problem: 'No HTML file named "Logo" was found in this Apps Script project.' };
}

/** Run this from the editor to diagnose the logo. Results appear in the Execution log. */
function checkLogo() {
  const info = readLogoFile_();
  const lines = ['=== DART logo check ==='];
  if (!info.found) {
    lines.push('RESULT: NOT FOUND');
    lines.push(info.problem);
    lines.push('FIX: Click + > HTML, name it exactly Logo, paste the full contents of Logo.html, then save.');
  } else if (!info.dataUrl) {
    lines.push('RESULT: FILE FOUND BUT INVALID (' + info.fileName + ', ' + info.length + ' characters)');
    lines.push(info.problem);
    lines.push('FIX: Select all inside the Logo file, delete it, paste the full Logo.html contents again, then save.');
  } else {
    let decodedBytes = 0;
    try {
      decodedBytes = Utilities.base64Decode(info.dataUrl.slice(info.dataUrl.indexOf(',') + 1)).length;
    } catch (e) {
      lines.push('RESULT: FILE FOUND BUT THE TEXT IS INCOMPLETE OR DAMAGED (' + info.length + ' characters). Re-paste the full Logo.html contents.');
      Logger.log(lines.join('\n'));
      return lines.join('\n');
    }
    lines.push('RESULT: OK');
    lines.push('File: ' + info.fileName + ' | Text length: ' + info.length + ' characters | Image size: ' + Math.round(decodedBytes / 1024) + ' KB');
    if (info.length < 25000) lines.push('WARNING: The text looks shorter than expected (~26,000 characters). It may have been cut off while pasting.');
    lines.push('Next: Deploy > Manage deployments > Edit > Version: New version > Deploy, then reload the web app.');
  }
  const msg = lines.join('\n');
  Logger.log(msg);
  return msg;
}

/** Returns the logo as a Blob for inserting into Google Docs, or null if unavailable. */
function getLogoBlob_() {
  const dataUrl = getLogoDataUrl_();
  if (!dataUrl) return null;
  const commaIdx = dataUrl.indexOf(',');
  const mimeType = dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png';
  try {
    return Utilities.newBlob(Utilities.base64Decode(dataUrl.slice(commaIdx + 1)), mimeType, 'logo');
  } catch (e) {
    return null;
  }
}

function getOrCreateFolder_(propKey, folderName) {
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty(propKey);
  if (savedId) {
    try {
      const saved = DriveApp.getFolderById(savedId);
      if (!saved.isTrashed()) return saved;
    } catch (e) {
      // Folder missing or inaccessible; fall through and recreate.
    }
  }
  const it = DriveApp.getFoldersByName(folderName);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(folderName);
  props.setProperty(propKey, folder.getId());
  return folder;
}

function applySharing_(file) {
  if (!CONFIG.SHARE_FILES_WITH_LINK) return;
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    Logger.log('Sharing not applied (domain policy?): ' + e.message);
  }
}

/** Decodes a base64 payload ({ base64, mimeType, fileName }) and saves it to the evidence folder. */
function saveEvidenceFile_(file, studentId) {
  if (!file || !file.base64) throw new Error('Evidence file is empty.');
  let base64 = String(file.base64);
  let mimeType = String(file.mimeType || '').toLowerCase().trim();

  if (base64.indexOf('data:') === 0) {
    const commaIdx = base64.indexOf(',');
    if (commaIdx === -1) throw new Error('Invalid evidence file encoding.');
    const meta = base64.slice(5, commaIdx);
    if (!mimeType) mimeType = meta.split(';')[0].toLowerCase();
    base64 = base64.slice(commaIdx + 1);
  }

  if (ALLOWED_UPLOAD_TYPES.indexOf(mimeType) === -1) {
    throw new Error('Unsupported evidence file type (' + (mimeType || 'unknown') + '). Upload an image (JPG, PNG, GIF, WEBP, HEIC) or PDF.');
  }

  let bytes;
  try {
    bytes = Utilities.base64Decode(base64);
  } catch (e) {
    throw new Error('Evidence file could not be decoded. Please re-select the file.');
  }
  if (bytes.length > CONFIG.MAX_UPLOAD_BYTES) {
    throw new Error('Evidence file exceeds the ' + Math.round(CONFIG.MAX_UPLOAD_BYTES / 1048576) + ' MB limit.');
  }

  const name = sanitizeFileName_(studentId) + '_' +
    formatDate_(new Date(), 'yyyyMMdd_HHmmss') + '_' +
    sanitizeFileName_(file.fileName || 'evidence');
  const blob = Utilities.newBlob(bytes, mimeType, name);
  const saved = getOrCreateFolder_(PROP_KEYS.EVIDENCE_FOLDER, CONFIG.EVIDENCE_FOLDER_NAME).createFile(blob);
  applySharing_(saved);
  return saved;
}

// ============================================================================
// 10. SYSTEM SETTINGS — STRICT ID-BASED CRUD
// ============================================================================

function getSettings_(includeInactive) {
  const table = readTable_(getSheet_(SHEET_NAMES.SETTINGS), SETTING_HEADERS);
  const m = table.map;
  const list = [];
  table.rows.forEach(function (r) {
    const id = String(r[m.setting_id]).trim();
    if (!id) return;
    const item = {
      setting_id: id,
      category: canonicalCategory_(r[m.category]) || String(r[m.category]).trim(),
      value: String(r[m.value]).trim(),
      is_active: toBool_(r[m.is_active])
    };
    if (!item.value) return;
    if (includeInactive || item.is_active) list.push(item);
  });
  return list;
}

function getSettingsGrouped_(includeInactive) {
  const grouped = {};
  SETTING_CATEGORIES.forEach(function (c) { grouped[c] = []; });
  getSettings_(includeInactive).forEach(function (s) {
    if (grouped[s.category]) grouped[s.category].push(s);
  });
  return grouped;
}

/** payload: { category, value, is_active? } */
function addSetting_(payload) {
  const p = payload || {};
  const category = requireCategory_(p.category);
  const value = cleanText_(p.value, FIELD_LIMITS.setting_value);
  if (!value) throw new Error('Setting value is required.');
  const isActive = p.is_active === undefined ? true : toBool_(p.is_active);

  return withLock_(function () {
    const sheet = getSheet_(SHEET_NAMES.SETTINGS);
    const table = readTable_(sheet, SETTING_HEADERS);
    assertNoDuplicateSetting_(table, category, value, null);
    const record = {
      setting_id: generateUniqueId_('SET', table, 'setting_id'),
      category: category,
      value: value,
      is_active: isActive
    };
    appendRecord_(sheet, table, SETTING_HEADERS, record, { checkboxColumns: ['is_active'] });
    audit_('CREATE', 'Setting', record.setting_id, { category: category, value: value });
    return { success: true, message: '"' + value + '" added to ' + category + '.', setting: record };
  });
}

/** payload: { setting_id, category?, value?, is_active? } */
function updateSetting_(payload) {
  const p = payload || {};
  const id = cleanText_(p.setting_id, 100);
  if (!id) throw new Error('setting_id is required.');

  return withLock_(function () {
    const sheet = getSheet_(SHEET_NAMES.SETTINGS);
    const table = readTable_(sheet, SETTING_HEADERS);
    const loc = locateById_(table, 'setting_id', id);
    if (!loc) throw new Error('Setting not found. It may have been deleted or its ID was changed in the sheet.');

    const m = table.map;
    const current = {
      setting_id: id,
      category: canonicalCategory_(loc.row[m.category]) || String(loc.row[m.category]).trim(),
      value: String(loc.row[m.value]).trim(),
      is_active: toBool_(loc.row[m.is_active])
    };

    const updates = {};
    if (p.category !== undefined) updates.category = requireCategory_(p.category);
    if (p.value !== undefined) {
      const v = cleanText_(p.value, FIELD_LIMITS.setting_value);
      if (!v) throw new Error('Setting value cannot be empty.');
      updates.value = v;
    }
    if (p.is_active !== undefined) updates.is_active = toBool_(p.is_active);

    const merged = Object.assign({}, current, updates);
    assertNoDuplicateSetting_(table, merged.category, merged.value, id);
    writeFields_(sheet, loc.rowNumber, m, updates);
    audit_('UPDATE', 'Setting', id, diffFields_(current, updates, ['category', 'value', 'is_active']));
    return { success: true, message: 'Setting updated.', setting: merged };
  });
}

function deleteSetting_(settingId) {
  const id = cleanText_(settingId, 100);
  if (!id) throw new Error('setting_id is required.');

  return withLock_(function () {
    const sheet = getSheet_(SHEET_NAMES.SETTINGS);
    const table = readTable_(sheet, SETTING_HEADERS);
    const loc = locateById_(table, 'setting_id', id);
    if (!loc) throw new Error('Setting not found. It may have already been deleted.');
    const value = String(loc.row[table.map.value]).trim();
    const category = String(loc.row[table.map.category]).trim();
    sheet.deleteRow(loc.rowNumber);
    audit_('DELETE', 'Setting', id, { category: category, value: value });
    return { success: true, message: '"' + value + '" deleted.', setting_id: id };
  });
}

function canonicalCategory_(category) {
  const key = normalizeKey_(category);
  for (let i = 0; i < SETTING_CATEGORIES.length; i++) {
    if (normalizeKey_(SETTING_CATEGORIES[i]) === key) return SETTING_CATEGORIES[i];
  }
  return '';
}

function requireCategory_(category) {
  const c = canonicalCategory_(category);
  if (!c) throw new Error('Invalid category. Allowed: ' + SETTING_CATEGORIES.join(', ') + '.');
  return c;
}

function assertNoDuplicateSetting_(table, category, value, excludeId) {
  const m = table.map;
  const catKey = normalizeKey_(category);
  const valKey = normalizeKey_(value);
  table.rows.forEach(function (r) {
    const id = String(r[m.setting_id]).trim();
    if (!id || id === excludeId) return;
    if (normalizeKey_(r[m.category]) === catKey && normalizeKey_(r[m.value]) === valKey) {
      throw new Error('"' + value + '" already exists under ' + category + '.');
    }
  });
}

function getFrequencyLabels_() {
  return getSettings_(false)
    .filter(function (s) { return s.category === 'Frequencies'; })
    .map(function (s) { return s.value; });
}

/** Ensures a dropdown value matches an active setting (case-insensitive) and returns its canonical spelling. */
function resolveSettingValue_(value, category, grouped) {
  const options = (grouped[category] || []).map(function (s) { return s.value; });
  if (!options.length) return value;
  const key = normalizeKey_(value);
  for (let i = 0; i < options.length; i++) {
    if (normalizeKey_(options[i]) === key) return options[i];
  }
  throw new Error('"' + value + '" is not an active option under ' + category + '. Update it in Configuration first.');
}

// ============================================================================
// 11. FREQUENCY & ESCALATION ENGINE
// ============================================================================

/** Preview call used by the Log Incident form. Accepts (studentId, infraction) or ({ student_id, infraction }). */
function calculateFrequency_(studentId, infraction) {
  if (studentId && typeof studentId === 'object') {
    infraction = studentId.infraction;
    studentId = studentId.student_id;
  }
  const sid = cleanText_(studentId, FIELD_LIMITS.student_id);
  const inf = cleanText_(infraction, FIELD_LIMITS.infraction);
  if (!sid) throw new Error('Student ID is required to calculate frequency.');
  const table = readTable_(getSheet_(SHEET_NAMES.LOGS), LOG_HEADERS);
  return computeFrequency_(table, sid, inf, { frequencyLabels: getFrequencyLabels_() });
}

/** Counts prior records for a student. options: { frequencyLabels, excludeLogId, before (Date) } */
function computeFrequency_(table, studentId, infraction, options) {
  const opts = options || {};
  const m = table.map;
  const sidKey = normalizeKey_(studentId);
  const infKey = normalizeKey_(infraction);
  const beforeMs = opts.before instanceof Date ? opts.before.getTime() : null;

  let specificPrior = 0;
  let overallPrior = 0;
  let latestMs = -1;
  let known = null;
  const breakdown = {};

  table.rows.forEach(function (r) {
    const logId = String(r[m.log_id]).trim();
    if (!logId) return;
    if (opts.excludeLogId && logId === opts.excludeLogId) return;
    if (normalizeKey_(r[m.student_id]) !== sidKey) return;

    const d = parseDate_(r[m.timestamp]);
    const ms = d ? d.getTime() : 0;
    if (beforeMs !== null && ms >= beforeMs) return;

    overallPrior++;
    const rowInfraction = String(r[m.infraction]).trim();
    increment_(breakdown, rowInfraction);
    if (infKey && normalizeKey_(rowInfraction) === infKey) specificPrior++;

    if (ms >= latestMs) {
      latestMs = ms;
      known = {
        student_name: String(r[m.student_name]).trim(),
        section: String(r[m.section]).trim()
      };
    }
  });

  const offenseNumber = infKey ? specificPrior + 1 : null;
  const overallNumber = overallPrior + 1;
  const escalated = overallNumber >= CONFIG.ESCALATION_THRESHOLD;

  return {
    student_id: String(studentId).trim(),
    infraction: String(infraction || '').trim(),
    specific_prior_count: specificPrior,
    offense_number: offenseNumber,
    frequency_label: offenseNumber ? resolveFrequencyLabel_(offenseNumber, opts.frequencyLabels || []) : '',
    overall_prior_count: overallPrior,
    overall_offense_number: overallNumber,
    escalation_threshold: CONFIG.ESCALATION_THRESHOLD,
    escalation_triggered: escalated,
    escalation_message: escalated ? ESCALATION_MESSAGE : '',
    infraction_breakdown: countsToArray_(breakdown, 'infraction'),
    known_student: known
  };
}

/** Uses a matching "Frequencies" setting (e.g. "3rd Offense") if one exists, otherwise generates the label. */
function resolveFrequencyLabel_(n, labels) {
  const ord = ordinal_(n).toLowerCase();
  for (let i = 0; i < labels.length; i++) {
    const k = String(labels[i]).trim().toLowerCase();
    if (k === ord || k.indexOf(ord + ' ') === 0) return String(labels[i]).trim();
  }
  return ordinal_(n) + ' Offense';
}

// ============================================================================
// 12. VIOLATION LOGS — INSERT / READ / UPDATE / DELETE
// ============================================================================

/**
 * payload: { student_id, student_name, section, infraction, severity, sanction, remarks, remark_status?,
 *            evidence_link?, evidence_file? { base64, mimeType, fileName } }
 */
function insertViolation_(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid submission.');

  const data = {
    student_id: cleanText_(payload.student_id, FIELD_LIMITS.student_id),
    student_name: cleanText_(payload.student_name, FIELD_LIMITS.student_name),
    section: cleanText_(payload.section, FIELD_LIMITS.section),
    infraction: cleanText_(payload.infraction, FIELD_LIMITS.infraction),
    severity: cleanText_(payload.severity, FIELD_LIMITS.severity),
    sanction: cleanText_(payload.sanction, FIELD_LIMITS.sanction),
    remarks: cleanText_(payload.remarks, FIELD_LIMITS.remarks),
    remark_status: cleanText_(payload.remark_status, FIELD_LIMITS.remark_status),
    evidence_link: cleanText_(payload.evidence_link, FIELD_LIMITS.evidence_link)
  };

  const required = { student_id: 'Student ID', student_name: 'Student Name', section: 'Section', infraction: 'Infraction', severity: 'Severity', sanction: 'Sanction' };
  const missing = Object.keys(required).filter(function (k) { return !data[k]; }).map(function (k) { return required[k]; });
  if (missing.length) throw new Error('Missing required field(s): ' + missing.join(', ') + '.');

  const grouped = getSettingsGrouped_(false);
  data.infraction = resolveSettingValue_(data.infraction, 'Infractions', grouped);
  data.severity = resolveSettingValue_(data.severity, 'Severity Levels', grouped);
  data.sanction = resolveSettingValue_(data.sanction, 'Sanctions', grouped);
  if (data.remark_status) data.remark_status = resolveSettingValue_(data.remark_status, 'Remarks', grouped);

  if (data.evidence_link && !/^https?:\/\//i.test(data.evidence_link)) {
    throw new Error('Evidence link must be a valid URL starting with http:// or https://');
  }

  let uploaded = null;
  if (payload.evidence_file && payload.evidence_file.base64) {
    uploaded = saveEvidenceFile_(payload.evidence_file, data.student_id);
    data.evidence_link = uploaded.getUrl();
  }

  const frequencyLabels = (grouped['Frequencies'] || []).map(function (s) { return s.value; });

  try {
    return withLock_(function () {
      const sheet = getSheet_(SHEET_NAMES.LOGS);
      const table = readTable_(sheet, LOG_HEADERS);
      const freq = computeFrequency_(table, data.student_id, data.infraction, { frequencyLabels: frequencyLabels });

      const record = {
        log_id: generateUniqueId_('LOG', table, 'log_id'),
        timestamp: new Date(),
        student_id: data.student_id,
        student_name: data.student_name,
        section: data.section,
        infraction: data.infraction,
        severity: data.severity,
        frequency: freq.frequency_label,
        sanction: data.sanction,
        remarks: data.remarks,
        evidence_link: data.evidence_link,
        report_pdf_link: '',
        remark_status: data.remark_status
      };

      appendRecord_(sheet, table, LOG_HEADERS, record);
      audit_('CREATE', 'Incident', record.log_id, {
        student_id: record.student_id, infraction: record.infraction, sanction: record.sanction, frequency: record.frequency
      });

      return {
        success: true,
        message: 'Incident logged for ' + record.student_name + ' (' + record.frequency + ').',
        log: serializeLog_(record),
        frequency: freq
      };
    });
  } catch (err) {
    if (uploaded) {
      try { uploaded.setTrashed(true); } catch (e) { /* ignore cleanup failure */ }
    }
    throw err;
  }
}

/** options: { search?, timeFilter?, student_id? } — newest first. */
function getViolations_(options) {
  const opts = options || {};
  const range = getDateRange_(opts.timeFilter);
  const query = normalizeKey_(opts.search);
  const sidKey = opts.student_id ? normalizeKey_(opts.student_id) : '';

  return getAllLogs_()
    .filter(function (rec) {
      if (!isInRange_(rec.timestamp, range)) return false;
      if (sidKey && normalizeKey_(rec.student_id) !== sidKey) return false;
      if (!query) return true;
      const haystack = normalizeKey_([
        rec.log_id, rec.student_id, rec.student_name, rec.section, rec.infraction,
        rec.severity, rec.frequency, rec.sanction, rec.remarks, rec.remark_status
      ].join(' '));
      return haystack.indexOf(query) !== -1;
    })
    .sort(sortByTimestampDesc_)
    .map(serializeLog_);
}

function getViolationById_(logId) {
  const id = cleanText_(logId, 100);
  if (!id) throw new Error('log_id is required.');
  const table = readTable_(getSheet_(SHEET_NAMES.LOGS), LOG_HEADERS);
  const loc = locateById_(table, 'log_id', id);
  if (!loc) throw new Error('Record not found. It may have been deleted.');
  return serializeLog_(rowToObject_(loc.row, table.map, LOG_HEADERS));
}

/** payload: { log_id, plus any editable field }. Frequency is recalculated if student_id or infraction changes. */
function updateViolation_(payload) {
  const p = payload || {};
  const logId = cleanText_(p.log_id, 100);
  if (!logId) throw new Error('log_id is required.');

  const editable = ['student_id', 'student_name', 'section', 'infraction', 'severity', 'sanction', 'remarks', 'remark_status', 'evidence_link'];
  const requiredFields = ['student_id', 'student_name', 'section', 'infraction', 'severity', 'sanction'];
  const updates = {};
  editable.forEach(function (f) {
    if (Object.prototype.hasOwnProperty.call(p, f)) {
      updates[f] = cleanText_(p[f], FIELD_LIMITS[f]);
      if (requiredFields.indexOf(f) !== -1 && !updates[f]) throw new Error(f + ' cannot be empty.');
    }
  });

  const grouped = getSettingsGrouped_(false);
  if (updates.infraction !== undefined) updates.infraction = resolveSettingValue_(updates.infraction, 'Infractions', grouped);
  if (updates.severity !== undefined) updates.severity = resolveSettingValue_(updates.severity, 'Severity Levels', grouped);
  if (updates.sanction !== undefined) updates.sanction = resolveSettingValue_(updates.sanction, 'Sanctions', grouped);
  if (updates.remark_status) updates.remark_status = resolveSettingValue_(updates.remark_status, 'Remarks', grouped);
  if (updates.evidence_link && !/^https?:\/\//i.test(updates.evidence_link)) {
    throw new Error('Evidence link must be a valid URL starting with http:// or https://');
  }

  let uploaded = null;
  if (p.evidence_file && p.evidence_file.base64) {
    uploaded = saveEvidenceFile_(p.evidence_file, updates.student_id || p.student_id || 'student');
    updates.evidence_link = uploaded.getUrl();
  }

  const frequencyLabels = (grouped['Frequencies'] || []).map(function (s) { return s.value; });

  try {
    return withLock_(function () {
      const sheet = getSheet_(SHEET_NAMES.LOGS);
      const table = readTable_(sheet, LOG_HEADERS);
      const loc = locateById_(table, 'log_id', logId);
      if (!loc) throw new Error('Record not found. It may have been deleted or its ID was changed in the sheet.');

      const current = rowToObject_(loc.row, table.map, LOG_HEADERS);
      const merged = Object.assign({}, current, updates);

      const idChanged = updates.student_id !== undefined && normalizeKey_(updates.student_id) !== normalizeKey_(current.student_id);
      const infChanged = updates.infraction !== undefined && normalizeKey_(updates.infraction) !== normalizeKey_(current.infraction);
      if (idChanged || infChanged) {
        const freq = computeFrequency_(table, merged.student_id, merged.infraction, {
          frequencyLabels: frequencyLabels,
          excludeLogId: logId,
          before: parseDate_(current.timestamp) || new Date()
        });
        updates.frequency = freq.frequency_label;
        merged.frequency = freq.frequency_label;
      }

      writeFields_(sheet, loc.rowNumber, table.map, updates);
      audit_('UPDATE', 'Incident', logId, diffFields_(current, updates, editable.concat(['frequency'])));
      return { success: true, message: 'Record updated.', log: serializeLog_(merged) };
    });
  } catch (err) {
    if (uploaded) {
      try { uploaded.setTrashed(true); } catch (e) { /* ignore cleanup failure */ }
    }
    throw err;
  }
}

/** Deletes the log row (Admin only). Evidence and PDF files are kept in Drive for audit purposes. */
function deleteViolation_(logId) {
  const id = cleanText_(logId, 100);
  if (!id) throw new Error('log_id is required.');

  return withLock_(function () {
    const sheet = getSheet_(SHEET_NAMES.LOGS);
    const table = readTable_(sheet, LOG_HEADERS);
    const loc = locateById_(table, 'log_id', id);
    if (!loc) throw new Error('Record not found. It may have already been deleted.');
    const rec = rowToObject_(loc.row, table.map, LOG_HEADERS);
    sheet.deleteRow(loc.rowNumber);
    const ts = parseDate_(rec.timestamp);
    audit_('DELETE', 'Incident', id, {
      student_id: String(rec.student_id), student_name: String(rec.student_name),
      infraction: String(rec.infraction), sanction: String(rec.sanction),
      logged: ts ? formatDate_(ts, 'yyyy-MM-dd HH:mm') : ''
    });
    return { success: true, message: 'Record deleted.', log_id: id };
  });
}

function getAllLogs_() {
  const table = readTable_(getSheet_(SHEET_NAMES.LOGS), LOG_HEADERS);
  const m = table.map;
  return table.rows
    .filter(function (r) { return String(r[m.log_id]).trim() !== ''; })
    .map(function (r) { return rowToObject_(r, m, LOG_HEADERS); });
}

/** Converts a record into a google.script.run-safe object (Date objects cannot be returned). */
function serializeLog_(rec) {
  const out = {};
  LOG_HEADERS.forEach(function (h) {
    const v = rec[h];
    if (v instanceof Date) out[h] = v.toISOString();
    else out[h] = v === undefined || v === null ? '' : String(v).trim();
  });
  const d = parseDate_(rec.timestamp);
  out.timestamp = d ? d.toISOString() : '';
  out.timestamp_display = d ? formatDate_(d, 'MMM d, yyyy h:mm a') : String(rec.timestamp || '');
  out.grade_level = extractGradeLevel_(rec.section);
  return out;
}

function sortByTimestampDesc_(a, b) {
  const da = parseDate_(a.timestamp);
  const db = parseDate_(b.timestamp);
  return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
}

// ============================================================================
// 13. PARENT CONFERENCES
// ============================================================================

function getAllConferences_() {
  const table = readTable_(getSheet_(SHEET_NAMES.CONFERENCES), CONFERENCE_HEADERS);
  const m = table.map;
  return table.rows
    .filter(function (r) { return String(r[m.conference_id]).trim() !== ''; })
    .map(function (r) { return rowToObject_(r, m, CONFERENCE_HEADERS); });
}

function serializeConference_(rec) {
  const d = parseDateOnly_(rec.conference_date) || parseDate_(rec.conference_date);
  const created = parseDate_(rec.created_at);
  const updated = parseDate_(rec.updated_at);
  return {
    conference_id: String(rec.conference_id || '').trim(),
    student_id: String(rec.student_id || '').trim(),
    student_name: String(rec.student_name || '').trim(),
    section: String(rec.section || '').trim(),
    conference_date: d ? formatDate_(d, 'yyyy-MM-dd') : '',
    conference_date_display: d ? formatDate_(d, 'MMM d, yyyy') : '',
    status: String(rec.status || '').trim(),
    guardian_name: String(rec.guardian_name || '').trim(),
    notes: String(rec.notes || '').trim(),
    outcome: String(rec.outcome || '').trim(),
    recorded_by: String(rec.recorded_by || '').trim(),
    created_at_display: created ? formatDate_(created, 'MMM d, yyyy h:mm a') : '',
    updated_at_display: updated ? formatDate_(updated, 'MMM d, yyyy h:mm a') : '',
    sort_ms: (d ? d.getTime() : 0) + (created ? created.getTime() / 1e6 : 0)
  };
}

/** opts: { student_id?, search?, status? } — newest conference date first. */
function listConferences_(opts) {
  const o = opts || {};
  const sidKey = o.student_id ? normalizeKey_(o.student_id) : '';
  const q = normalizeKey_(o.search);
  const statusKey = normalizeKey_(o.status);
  return getAllConferences_()
    .map(serializeConference_)
    .filter(function (c) {
      if (sidKey && normalizeKey_(c.student_id) !== sidKey) return false;
      if (statusKey && normalizeKey_(c.status) !== statusKey) return false;
      if (q && normalizeKey_([c.student_id, c.student_name, c.section, c.guardian_name, c.status, c.notes, c.outcome].join(' ')).indexOf(q) === -1) return false;
      return true;
    })
    .sort(function (a, b) { return b.sort_ms - a.sort_ms; });
}

/** Create (no conference_id) or update (with conference_id). */
function saveConference_(payload) {
  const p = payload || {};
  const id = cleanText_(p.conference_id, 100);
  const data = {
    student_id: cleanText_(p.student_id, FIELD_LIMITS.student_id),
    student_name: cleanText_(p.student_name, FIELD_LIMITS.student_name),
    section: cleanText_(p.section, FIELD_LIMITS.section),
    status: cleanText_(p.status, 40),
    guardian_name: cleanText_(p.guardian_name, FIELD_LIMITS.guardian_name),
    notes: cleanText_(p.notes, FIELD_LIMITS.notes),
    outcome: cleanText_(p.outcome, FIELD_LIMITS.outcome)
  };
  const date = parseDateOnly_(p.conference_date);
  if (!data.student_id || !data.student_name || !data.section) throw new Error('Student ID, name and section are required.');
  if (!date) throw new Error('Please choose a valid conference date.');
  if (CONFERENCE_STATUSES.indexOf(data.status) === -1) throw new Error('Please choose a valid conference status.');
  data.conference_date = date;

  return withLock_(function () {
    const sheet = getSheet_(SHEET_NAMES.CONFERENCES);
    const table = readTable_(sheet, CONFERENCE_HEADERS);
    const now = new Date();
    if (!id) {
      const record = Object.assign({
        conference_id: generateUniqueId_('CNF', table, 'conference_id'),
        recorded_by: CURRENT_USER_ ? CURRENT_USER_.username : '',
        created_at: now,
        updated_at: now
      }, data);
      appendRecord_(sheet, table, CONFERENCE_HEADERS, record);
      audit_('CREATE', 'Conference', record.conference_id, {
        student_id: data.student_id, status: data.status, date: formatDate_(date, 'yyyy-MM-dd')
      });
      return { success: true, message: 'Conference recorded for ' + data.student_name + '.', conference: serializeConference_(record) };
    }
    const loc = locateById_(table, 'conference_id', id);
    if (!loc) throw new Error('Conference record not found. It may have been deleted.');
    const current = rowToObject_(loc.row, table.map, CONFERENCE_HEADERS);
    const updates = Object.assign({}, data, { updated_at: now });
    writeFields_(sheet, loc.rowNumber, table.map, updates);
    audit_('UPDATE', 'Conference', id, diffFields_(current, data, ['student_id', 'student_name', 'section', 'conference_date', 'status', 'guardian_name', 'notes', 'outcome']));
    return { success: true, message: 'Conference updated.', conference: serializeConference_(Object.assign({}, current, updates)) };
  });
}

function deleteConference_(conferenceId) {
  const id = cleanText_(conferenceId, 100);
  if (!id) throw new Error('conference_id is required.');
  return withLock_(function () {
    const sheet = getSheet_(SHEET_NAMES.CONFERENCES);
    const table = readTable_(sheet, CONFERENCE_HEADERS);
    const loc = locateById_(table, 'conference_id', id);
    if (!loc) throw new Error('Conference record not found.');
    const rec = rowToObject_(loc.row, table.map, CONFERENCE_HEADERS);
    sheet.deleteRow(loc.rowNumber);
    audit_('DELETE', 'Conference', id, { student_id: String(rec.student_id), status: String(rec.status) });
    return { success: true, message: 'Conference record deleted.' };
  });
}

/** Map of student key -> { latest conference, held: boolean, total } */
function getConferenceIndex_() {
  const index = {};
  getAllConferences_().map(serializeConference_).forEach(function (c) {
    const key = normalizeKey_(c.student_id);
    if (!key) return;
    if (!index[key]) index[key] = { latest: null, held: false, total: 0 };
    const entry = index[key];
    entry.total++;
    if (c.status === 'Held') entry.held = true;
    if (!entry.latest || c.sort_ms > entry.latest.sort_ms) entry.latest = c;
  });
  return index;
}

// ============================================================================
// 14. STUDENT DIRECTORY & ESCALATION WATCHLIST
// ============================================================================

function getStudentDirectory_(search) {
  const query = normalizeKey_(search);
  const index = buildStudentIndex_(getAllLogs_());
  const confIndex = getConferenceIndex_();
  return Object.keys(index)
    .map(function (k) { return finalizeStudent_(index[k], confIndex[k]); })
    .filter(function (s) {
      if (!query) return true;
      return normalizeKey_([s.student_id, s.student_name, s.section].join(' ')).indexOf(query) !== -1;
    })
    .sort(function (a, b) { return b.last_offense_ms - a.last_offense_ms; });
}

function getEscalationWatchlist_() {
  const index = buildStudentIndex_(getAllLogs_());
  const confIndex = getConferenceIndex_();
  return Object.keys(index)
    .map(function (k) { return finalizeStudent_(index[k], confIndex[k]); })
    .filter(function (s) { return s.escalated; })
    .sort(function (a, b) {
      if (a.conference_held !== b.conference_held) return a.conference_held ? 1 : -1;
      return b.total_offenses - a.total_offenses || b.last_offense_ms - a.last_offense_ms;
    });
}

/** Returns { logs, conferences } for one student. */
function getStudentHistory_(studentId) {
  const sid = cleanText_(studentId, FIELD_LIMITS.student_id);
  if (!sid) throw new Error('Student ID is required.');
  return {
    logs: getViolations_({ student_id: sid }),
    conferences: listConferences_({ student_id: sid })
  };
}

function buildStudentIndex_(records) {
  const index = {};
  records.forEach(function (rec) {
    const key = normalizeKey_(rec.student_id);
    if (!key) return;
    const d = parseDate_(rec.timestamp);
    const ms = d ? d.getTime() : 0;

    if (!index[key]) {
      index[key] = {
        student_id: String(rec.student_id).trim(),
        student_name: '',
        section: '',
        last_infraction: '',
        last_sanction: '',
        total_offenses: 0,
        last_offense_ms: -1,
        infractions: {},
        sanctions: {}
      };
    }
    const s = index[key];
    s.total_offenses++;
    increment_(s.infractions, rec.infraction);
    increment_(s.sanctions, rec.sanction);
    if (ms >= s.last_offense_ms) {
      s.last_offense_ms = ms;
      s.student_name = String(rec.student_name || '').trim();
      s.section = String(rec.section || '').trim();
      s.last_infraction = String(rec.infraction || '').trim();
      s.last_sanction = String(rec.sanction || '').trim();
    }
  });
  return index;
}

function finalizeStudent_(s, conf) {
  const lastMs = Math.max(s.last_offense_ms, 0);
  const lastDate = lastMs > 0 ? new Date(lastMs) : null;
  const escalated = s.total_offenses >= CONFIG.ESCALATION_THRESHOLD;
  const latest = conf && conf.latest ? conf.latest : null;
  return {
    student_id: s.student_id,
    student_name: s.student_name,
    section: s.section,
    grade_level: extractGradeLevel_(s.section),
    total_offenses: s.total_offenses,
    last_infraction: s.last_infraction,
    last_sanction: s.last_sanction,
    last_offense: lastDate ? lastDate.toISOString() : '',
    last_offense_display: lastDate ? formatDate_(lastDate, 'MMM d, yyyy h:mm a') : '',
    last_offense_ms: lastMs,
    infraction_breakdown: countsToArray_(s.infractions, 'infraction'),
    sanction_breakdown: countsToArray_(s.sanctions, 'sanction'),
    escalated: escalated,
    escalation_message: escalated ? ESCALATION_MESSAGE : '',
    conference_held: !!(conf && conf.held),
    conference_count: conf ? conf.total : 0,
    conference_status: latest ? latest.status : '',
    conference_date_display: latest ? latest.conference_date_display : ''
  };
}

// ============================================================================
// 15. INCIDENT PDF REPORT
// ============================================================================

function generatePDFReport_(logId) {
  const id = cleanText_(logId, 100);
  if (!id) throw new Error('log_id is required.');

  const templateId = getTemplateId_();
  let template;
  try {
    template = DriveApp.getFileById(templateId);
  } catch (e) {
    throw new Error('Report template not found or not accessible (ID: ' + templateId + '). Check CONFIG.TEMPLATE_DOC_ID or run createSampleTemplate().');
  }
  if (template.getMimeType() !== MimeType.GOOGLE_DOCS) {
    throw new Error('The report template must be a Google Docs file.');
  }

  const sheet = getSheet_(SHEET_NAMES.LOGS);
  const table = readTable_(sheet, LOG_HEADERS);
  const loc = locateById_(table, 'log_id', id);
  if (!loc) throw new Error('Record not found. It may have been deleted.');
  const record = rowToObject_(loc.row, table.map, LOG_HEADERS);

  const folder = getOrCreateFolder_(PROP_KEYS.REPORTS_FOLDER, CONFIG.REPORTS_FOLDER_NAME);
  const recDate = parseDate_(record.timestamp) || new Date();
  const baseName = 'Incident_Report_' + sanitizeFileName_(record.student_id) + '_' + formatDate_(recDate, 'yyyyMMdd') + '_' + id;

  const tempCopy = template.makeCopy(baseName + '_TEMP', folder);
  let pdfFile;
  try {
    const doc = DocumentApp.openById(tempCopy.getId());
    const tags = buildTemplateTags_(record);
    const logoBlob = getLogoBlob_();
    [doc.getBody(), doc.getHeader(), doc.getFooter()].forEach(function (section) {
      if (!section) return;
      insertLogoAtTag_(section, logoBlob);
      Object.keys(tags).forEach(function (tag) { replaceTagLiteral_(section, tag, tags[tag]); });
    });
    doc.saveAndClose();

    const pdfBlob = tempCopy.getAs(MimeType.PDF).setName(baseName + '.pdf');
    pdfFile = folder.createFile(pdfBlob);
    applySharing_(pdfFile);
  } finally {
    try { tempCopy.setTrashed(true); } catch (e) { /* ignore cleanup failure */ }
  }

  const pdfUrl = pdfFile.getUrl();
  withLock_(function () {
    const fresh = readTable_(sheet, LOG_HEADERS);
    const again = locateById_(fresh, 'log_id', id);
    if (!again) {
      pdfFile.setTrashed(true);
      throw new Error('The record was deleted while the report was being generated.');
    }
    writeFields_(sheet, again.rowNumber, fresh.map, { report_pdf_link: pdfUrl });
  });
  audit_('GENERATE_REPORT', 'Incident', id, { file: baseName + '.pdf' });

  return {
    success: true,
    message: 'PDF report generated.',
    log_id: id,
    pdf_url: pdfUrl,
    file_name: baseName + '.pdf'
  };
}

function getTemplateId_() {
  const configured = String(CONFIG.TEMPLATE_DOC_ID || '').trim();
  if (configured && configured.indexOf('DUMMY') !== 0) return configured;
  const stored = PropertiesService.getScriptProperties().getProperty(PROP_KEYS.TEMPLATE_DOC);
  if (stored) return stored;
  throw new Error('No report template configured. Run createSampleTemplate() once from the editor, or set CONFIG.TEMPLATE_DOC_ID to your Google Doc template ID.');
}

function buildTemplateTags_(rec) {
  const d = parseDate_(rec.timestamp);
  const now = new Date();
  const v = function (x) {
    const s = cleanText_(x, 5000).replace(/\{\{|\}\}/g, '');
    return s || 'N/A';
  };
  return {
    '{{log_id}}': v(rec.log_id),
    '{{timestamp}}': d ? formatDate_(d, 'MMMM d, yyyy h:mm a') : 'N/A',
    '{{date}}': d ? formatDate_(d, 'MMMM d, yyyy') : 'N/A',
    '{{time}}': d ? formatDate_(d, 'h:mm a') : 'N/A',
    '{{student_id}}': v(rec.student_id),
    '{{student_name}}': v(rec.student_name),
    '{{section}}': v(rec.section),
    '{{grade_level}}': v(extractGradeLevel_(rec.section)),
    '{{infraction}}': v(rec.infraction),
    '{{severity}}': v(rec.severity),
    '{{frequency}}': v(rec.frequency),
    '{{sanction}}': v(rec.sanction),
    '{{remarks}}': v(rec.remarks),
    '{{remark_status}}': v(rec.remark_status),
    '{{evidence_link}}': v(rec.evidence_link),
    '{{generated_on}}': formatDate_(now, 'MMMM d, yyyy h:mm a'),
    '{{generated_by}}': v(actorName_()),
    '{{school_name}}': CONFIG.SCHOOL_NAME,
    '{{department}}': CONFIG.DEPARTMENT_NAME
  };
}

/** Literal (non-regex) replacement that keeps the tag's formatting and handles special characters safely. */
function replaceTagLiteral_(section, tag, value) {
  const pattern = escapeRegex_(tag);
  const replacement = String(value);
  let guard = 0;
  let found = section.findText(pattern);
  while (found && guard < 1000) {
    const text = found.getElement().asText();
    const start = found.getStartOffset();
    const end = found.getEndOffsetInclusive();
    text.insertText(start, replacement);
    text.deleteText(start + replacement.length, end + replacement.length);
    found = section.findText(pattern);
    guard++;
  }
}

/** Replaces every {{logo}} tag in a document section with the school logo image. */
function insertLogoAtTag_(section, logoBlob) {
  const pattern = escapeRegex_('{{logo}}');
  let found = section.findText(pattern);
  let guard = 0;
  while (found && guard < 20) {
    const textEl = found.getElement().asText();
    const parent = textEl.getParent();
    const childIndex = parent ? parent.getChildIndex(textEl) : 0;
    textEl.replaceText(pattern, '');
    if (logoBlob && parent && typeof parent.insertInlineImage === 'function') {
      const img = parent.insertInlineImage(childIndex, logoBlob.copyBlob());
      sizeImage_(img, CONFIG.REPORT_LOGO_WIDTH);
    }
    found = section.findText(pattern);
    guard++;
  }
}

function sizeImage_(img, width) {
  const w = img.getWidth();
  const h = img.getHeight();
  if (w > 0) {
    img.setWidth(width);
    img.setHeight(Math.round(h * width / w));
  }
}

/** Creates a ready-to-use incident report template Doc and registers it automatically. */
function createSampleTemplate() {
  assertEditor_();
  const doc = DocumentApp.create('DART - Incident Report Template');
  const body = doc.getBody();

  const logoLine = body.getParagraphs()[0];
  logoLine.setText('{{logo}}');
  logoLine.setAlignment(DocumentApp.HorizontalAlignment.CENTER);

  const school = body.appendParagraph('{{school_name}}');
  school.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  school.editAsText().setBold(true).setFontSize(13);

  const dept = body.appendParagraph('{{department}}');
  dept.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  dept.editAsText().setBold(false).setFontSize(11);

  body.appendHorizontalRule();

  const title = body.appendParagraph('STUDENT INCIDENT REPORT');
  title.setHeading(DocumentApp.ParagraphHeading.HEADING1);
  title.setAlignment(DocumentApp.HorizontalAlignment.CENTER);

  const ref = body.appendParagraph('Reference No.: {{log_id}}');
  ref.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  body.appendParagraph('');

  const rows = [
    ['Date & Time of Incident', '{{timestamp}}'],
    ['Student ID', '{{student_id}}'],
    ['Student Name', '{{student_name}}'],
    ['Grade Level', '{{grade_level}}'],
    ['Section', '{{section}}'],
    ['Infraction', '{{infraction}}'],
    ['Severity', '{{severity}}'],
    ['Frequency', '{{frequency}}'],
    ['Sanction', '{{sanction}}'],
    ['Remarks Status', '{{remark_status}}'],
    ['Evidence', '{{evidence_link}}']
  ];
  const table = body.appendTable(rows);
  for (let i = 0; i < table.getNumRows(); i++) {
    table.getRow(i).getCell(0).editAsText().setBold(true);
  }

  const remarksHeading = body.appendParagraph('Remarks');
  remarksHeading.setHeading(DocumentApp.ParagraphHeading.HEADING3);
  body.appendParagraph('{{remarks}}');
  body.appendParagraph('');
  body.appendParagraph('Prepared by: ______________________________');
  body.appendParagraph('Noted by (Parent/Guardian): ______________________________');
  body.appendParagraph('');

  const footer = body.appendParagraph('Generated on {{generated_on}} by {{generated_by}} · CONFIDENTIAL — protected under RA 10173');
  footer.editAsText().setItalic(true).setFontSize(9);

  doc.saveAndClose();
  const id = doc.getId();
  PropertiesService.getScriptProperties().setProperty(PROP_KEYS.TEMPLATE_DOC, id);
  Logger.log('Template created and registered. ID: ' + id + '\nURL: ' + doc.getUrl());
  return id;
}

// ============================================================================
// 16. STATISTICS (DASHBOARD + SUMMARY REPORT)
// ============================================================================

/** Computes every breakdown for a time range. Used by the dashboard and the summary report. */
function computeStats_(filter) {
  const range = getDateRange_(filter);
  const all = getAllLogs_();
  const inRange = all.filter(function (rec) { return isInRange_(rec.timestamp, range); });

  const gradeCounts = {};
  const sectionCounts = {};
  const sectionGrade = {};
  const sanctionCounts = {};
  const infractionCounts = {};
  const severityCounts = {};
  const remarkCounts = {};
  const students = {};

  inRange.forEach(function (rec) {
    const grade = extractGradeLevel_(rec.section);
    const section = String(rec.section || '').trim() || 'Unspecified';
    increment_(gradeCounts, grade);
    increment_(sectionCounts, section);
    sectionGrade[section] = grade;
    increment_(sanctionCounts, rec.sanction);
    increment_(infractionCounts, rec.infraction);
    increment_(severityCounts, rec.severity);
    increment_(remarkCounts, String(rec.remark_status || '').trim() || 'No status');
    students[normalizeKey_(rec.student_id)] = true;
  });

  const allTimeIndex = buildStudentIndex_(all);
  const confIndex = getConferenceIndex_();
  const escalated = Object.keys(allTimeIndex)
    .map(function (k) { return finalizeStudent_(allTimeIndex[k], confIndex[k]); })
    .filter(function (s) { return s.escalated; })
    .sort(function (a, b) { return b.total_offenses - a.total_offenses; });

  const conferencesInRange = getAllConferences_().map(serializeConference_).filter(function (c) {
    return isInRange_(parseDateOnly_(c.conference_date), range);
  });
  const confStatusCounts = {};
  conferencesInRange.forEach(function (c) { increment_(confStatusCounts, c.status); });

  const sectionBreakdown = countsToArray_(sectionCounts, 'section').map(function (item) {
    item.grade_level = sectionGrade[item.section] || 'Unspecified';
    return item;
  });

  return {
    range: range,
    records: inRange,
    filter: range.key,
    filter_label: range.label,
    range_text: rangeText_(range),
    total_infractions: inRange.length,
    unique_students: Object.keys(students).length,
    escalated_list: escalated,
    escalated_students: escalated.length,
    pending_conferences: escalated.filter(function (s) { return !s.conference_held; }).length,
    conferences_in_period: conferencesInRange.length,
    conference_status_breakdown: countsToArray_(confStatusCounts, 'status'),
    escalation_threshold: CONFIG.ESCALATION_THRESHOLD,
    grade_level_breakdown: countsToArray_(gradeCounts, 'grade_level'),
    section_breakdown: sectionBreakdown,
    sanctions_summary: countsToArray_(sanctionCounts, 'sanction'),
    infraction_breakdown: countsToArray_(infractionCounts, 'infraction'),
    severity_breakdown: countsToArray_(severityCounts, 'severity'),
    remark_status_breakdown: countsToArray_(remarkCounts, 'remark_status'),
    trend: buildTrend_(inRange, range)
  };
}

/** Buckets incidents by hour (Today), day (≤ 35 days) or month (longer ranges). */
function buildTrend_(records, range) {
  const now = new Date();
  let start = range.start;
  let end = range.end;
  if (!start) {
    let earliest = null;
    records.forEach(function (r) {
      const d = parseDate_(r.timestamp);
      if (d && (!earliest || d < earliest)) earliest = d;
    });
    end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    start = earliest ? new Date(earliest.getFullYear(), earliest.getMonth(), 1) : new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const minStart = new Date(now.getFullYear(), now.getMonth() - 23, 1);
    if (start < minStart) start = minStart;
  }
  const spanDays = (end.getTime() - start.getTime()) / 86400000;
  const unit = spanDays <= 1.01 ? 'hour' : (spanDays <= 35 ? 'day' : 'month');
  const keyPattern = unit === 'hour' ? 'yyyy-MM-dd HH' : (unit === 'day' ? 'yyyy-MM-dd' : 'yyyy-MM');
  const labelPattern = unit === 'hour' ? 'h a' : (unit === 'day' ? 'MMM d' : 'MMM yyyy');

  const points = [];
  const index = {};
  let cursor = new Date(start.getTime());
  let guard = 0;
  while (cursor < end && guard < 400) {
    let next;
    if (unit === 'hour') next = new Date(cursor.getTime() + 3600000);
    else if (unit === 'day') next = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    else next = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    const key = formatDate_(cursor, keyPattern);
    index[key] = points.length;
    points.push({ key: key, label: formatDate_(cursor, labelPattern), count: 0 });
    cursor = next;
    guard++;
  }
  records.forEach(function (r) {
    const d = parseDate_(r.timestamp);
    if (!d) return;
    const k = formatDate_(d, keyPattern);
    if (k in index) points[index[k]].count++;
  });
  return { unit: unit, points: points };
}

/** timeFilter: ALL | TODAY | WEEK | MONTH | SEM1 | SEM2 | ACADEMIC_YEAR */
function getDashboardStats_(timeFilter) {
  const s = computeStats_(timeFilter);
  return {
    filter: s.filter,
    filter_label: s.filter_label,
    range_text: s.range_text,
    total_infractions: s.total_infractions,
    unique_students: s.unique_students,
    escalated_students: s.escalated_students,
    pending_conferences: s.pending_conferences,
    conferences_in_period: s.conferences_in_period,
    escalation_threshold: s.escalation_threshold,
    grade_level_breakdown: s.grade_level_breakdown,
    section_breakdown: s.section_breakdown,
    sanctions_summary: s.sanctions_summary,
    infraction_breakdown: s.infraction_breakdown,
    severity_breakdown: s.severity_breakdown,
    remark_status_breakdown: s.remark_status_breakdown,
    trend: s.trend,
    recent_logs: s.records.slice().sort(sortByTimestampDesc_).slice(0, 5).map(serializeLog_),
    generated_at: new Date().toISOString()
  };
}

// ============================================================================
// 17. SUMMARY REPORT (PDF + EXCEL/CSV)
// ============================================================================

/** format: 'pdf' | 'csv'. Returns { fileName, mimeType, base64 | content, drive_url? } */
function generateSummaryReport_(timeFilter, format) {
  const fmt = String(format || 'pdf').toLowerCase() === 'csv' ? 'csv' : 'pdf';
  const s = computeStats_(timeFilter);
  const stamp = formatDate_(new Date(), 'yyyyMMdd_HHmm');
  const baseName = 'DART_Summary_' + s.filter + '_' + stamp;
  audit_('SUMMARY_REPORT', 'Report', s.filter, { format: fmt, period: s.filter_label, incidents: s.total_infractions });
  if (fmt === 'csv') {
    return { fileName: baseName + '.csv', mimeType: 'text/csv', content: buildSummaryCsv_(s), filter_label: s.filter_label, total: s.total_infractions };
  }
  return buildSummaryPdf_(s, baseName);
}

function pct_(count, total) {
  return total ? (Math.round(count / total * 1000) / 10).toFixed(1) + '%' : '0.0%';
}

function summarySections_(s) {
  const t = s.total_infractions;
  const rows = function (items, key, extra) {
    return items.map(function (i) {
      const r = [i[key]];
      if (extra) r.push(i[extra]);
      r.push(String(i.count));
      r.push(pct_(i.count, t));
      return r;
    });
  };
  return [
    { title: 'Infractions', headers: ['Infraction', 'Count', 'Share'], rows: rows(s.infraction_breakdown, 'infraction') },
    { title: 'Sanctions Issued', headers: ['Sanction', 'Count', 'Share'], rows: rows(s.sanctions_summary, 'sanction') },
    { title: 'By Grade Level', headers: ['Grade Level', 'Count', 'Share'], rows: rows(s.grade_level_breakdown, 'grade_level') },
    { title: 'By Section', headers: ['Section', 'Grade Level', 'Count', 'Share'], rows: rows(s.section_breakdown, 'section', 'grade_level') },
    { title: 'By Severity', headers: ['Severity', 'Count', 'Share'], rows: rows(s.severity_breakdown, 'severity') },
    { title: 'By Remarks Status', headers: ['Remarks Status', 'Count', 'Share'], rows: rows(s.remark_status_breakdown, 'remark_status') },
    {
      title: 'Incidents Over Time',
      headers: [s.trend.unit === 'month' ? 'Month' : (s.trend.unit === 'day' ? 'Date' : 'Hour'), 'Incidents'],
      rows: s.trend.points.map(function (p) { return [p.label, String(p.count)]; })
    },
    {
      title: 'Escalation Watchlist (' + s.escalation_threshold + '+ offenses, all time)',
      headers: ['Student', 'Student ID', 'Section', 'Offenses', 'Parent Conference'],
      rows: s.escalated_list.map(function (x) {
        return [x.student_name, x.student_id, x.section, String(x.total_offenses),
          x.conference_status ? x.conference_status + (x.conference_date_display ? ' (' + x.conference_date_display + ')' : '') : 'None recorded'];
      })
    }
  ];
}

function overviewRows_(s) {
  return [
    ['Total incidents', String(s.total_infractions)],
    ['Students involved', String(s.unique_students)],
    ['Students on escalation watchlist (all time)', String(s.escalated_students)],
    ['Watchlist students without a held parent conference', String(s.pending_conferences)],
    ['Parent conferences recorded in this period', String(s.conferences_in_period)]
  ];
}

function buildSummaryCsv_(s) {
  const lines = [];
  const add = function (cells) { lines.push(cells.map(csvCell_).join(',')); };
  add(['DART — Disciplinary Summary Report']);
  add([CONFIG.SCHOOL_NAME]);
  add([CONFIG.DEPARTMENT_NAME]);
  add(['Period', s.filter_label]);
  add(['Coverage', s.range_text]);
  add(['Generated', formatDate_(new Date(), 'MMMM d, yyyy h:mm a'), 'by', actorName_()]);
  lines.push('');
  add(['OVERVIEW']);
  add(['Metric', 'Value']);
  overviewRows_(s).forEach(add);
  summarySections_(s).forEach(function (sec) {
    lines.push('');
    add([sec.title.toUpperCase()]);
    add(sec.headers);
    if (sec.rows.length) sec.rows.forEach(add);
    else add(['No data for this period']);
  });
  lines.push('');
  add(['CONFIDENTIAL — Contains personal information protected under RA 10173 (Data Privacy Act of 2012).']);
  return '﻿' + lines.join('\r\n');
}

function styleTable_(table, colWidths) {
  table.setBorderColor('#cbd5e1');
  for (let r = 0; r < table.getNumRows(); r++) {
    const row = table.getRow(r);
    for (let c = 0; c < row.getNumCells(); c++) {
      const cell = row.getCell(c);
      cell.setPaddingTop(3).setPaddingBottom(3).setPaddingLeft(6).setPaddingRight(6);
      const text = cell.editAsText();
      text.setFontSize(10);
      if (r === 0) {
        cell.setBackgroundColor('#1e40af');
        text.setBold(true).setForegroundColor('#ffffff');
      } else {
        text.setBold(false).setForegroundColor('#0f172a');
        if (r % 2 === 0) cell.setBackgroundColor('#f1f5f9');
      }
    }
  }
  if (colWidths) colWidths.forEach(function (w, i) { if (w) table.setColumnWidth(i, w); });
}

function buildSummaryPdf_(s, baseName) {
  const doc = DocumentApp.create(baseName);
  const body = doc.getBody();
  body.setMarginTop(36).setMarginBottom(36).setMarginLeft(54).setMarginRight(54);

  const first = body.getParagraphs()[0];
  first.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  const logo = getLogoBlob_();
  if (logo) sizeImage_(first.appendInlineImage(logo), 80);

  const school = body.appendParagraph(CONFIG.SCHOOL_NAME);
  school.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  school.editAsText().setBold(true).setFontSize(13).setForegroundColor('#0f172a');
  const dept = body.appendParagraph(CONFIG.DEPARTMENT_NAME);
  dept.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  dept.editAsText().setBold(false).setFontSize(11).setForegroundColor('#334155');
  body.appendHorizontalRule();

  const title = body.appendParagraph('DISCIPLINARY SUMMARY REPORT');
  title.setHeading(DocumentApp.ParagraphHeading.HEADING1);
  title.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  title.editAsText().setFontSize(16).setBold(true).setForegroundColor('#1e40af');

  const period = body.appendParagraph(s.filter_label + '  ·  ' + s.range_text);
  period.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  period.editAsText().setFontSize(10).setBold(false).setForegroundColor('#334155');
  const gen = body.appendParagraph('Generated ' + formatDate_(new Date(), 'MMMM d, yyyy h:mm a') + ' by ' + actorName_());
  gen.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  gen.editAsText().setFontSize(9).setItalic(true).setForegroundColor('#64748b');

  const heading = function (text) {
    const h = body.appendParagraph(text);
    h.setHeading(DocumentApp.ParagraphHeading.HEADING2);
    h.editAsText().setFontSize(12).setBold(true).setItalic(false).setForegroundColor('#1e40af');
    return h;
  };

  heading('Overview');
  styleTable_(body.appendTable([['Metric', 'Value']].concat(overviewRows_(s))), [380, 120]);

  summarySections_(s).forEach(function (sec) {
    heading(sec.title);
    if (!sec.rows.length) {
      const none = body.appendParagraph('No data for this period.');
      none.editAsText().setFontSize(10).setItalic(true).setBold(false).setForegroundColor('#64748b');
      return;
    }
    const widths = sec.headers.length === 2 ? [380, 120] : (sec.headers.length === 3 ? [300, 100, 100] : null);
    styleTable_(body.appendTable([sec.headers].concat(sec.rows)), widths);
  });

  body.appendParagraph('');
  const sig = body.appendTable([
    ['Prepared by:', 'Noted by:'],
    ['\n\n______________________________\nSignature over printed name', '\n\n______________________________\nSHS Principal / Discipline Officer']
  ]);
  sig.setBorderWidth(0);
  for (let r = 0; r < sig.getNumRows(); r++) {
    for (let c = 0; c < 2; c++) {
      sig.getRow(r).getCell(c).editAsText().setFontSize(10).setBold(r === 0).setItalic(false).setForegroundColor('#0f172a');
    }
  }

  const conf = body.appendParagraph('CONFIDENTIAL — This report contains personal information protected under Republic Act No. 10173 (Data Privacy Act of 2012). For official school use only.');
  conf.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  conf.editAsText().setFontSize(8).setItalic(true).setBold(false).setForegroundColor('#64748b');

  doc.saveAndClose();
  const docFile = DriveApp.getFileById(doc.getId());
  let pdfFile;
  try {
    const pdfBlob = docFile.getAs(MimeType.PDF).setName(baseName + '.pdf');
    pdfFile = getOrCreateFolder_(PROP_KEYS.REPORTS_FOLDER, CONFIG.REPORTS_FOLDER_NAME).createFile(pdfBlob);
    applySharing_(pdfFile);
  } finally {
    try { docFile.setTrashed(true); } catch (e) { /* ignore cleanup failure */ }
  }
  return {
    fileName: baseName + '.pdf',
    mimeType: 'application/pdf',
    base64: Utilities.base64Encode(pdfFile.getBlob().getBytes()),
    drive_url: pdfFile.getUrl(),
    filter_label: s.filter_label,
    total: s.total_infractions
  };
}

// ============================================================================
// 18. RAW DATA EXPORT (CSV)
// ============================================================================

function exportViolationsCsv_(timeFilter) {
  const range = getDateRange_(timeFilter);
  const logs = getAllLogs_()
    .filter(function (rec) { return isInRange_(rec.timestamp, range); })
    .sort(function (a, b) { return sortByTimestampDesc_(b, a); });

  const lines = [LOG_HEADERS.join(',')];
  logs.forEach(function (rec) {
    lines.push(LOG_HEADERS.map(function (h) {
      if (h === 'timestamp') {
        const d = parseDate_(rec.timestamp);
        return csvCell_(d ? formatDate_(d, 'yyyy-MM-dd HH:mm:ss') : '');
      }
      return csvCell_(rec[h]);
    }).join(','));
  });

  audit_('EXPORT', 'Incident', range.key, { rows: logs.length, period: range.label });
  return {
    fileName: 'DART_Export_' + range.key + '_' + formatDate_(new Date(), 'yyyyMMdd_HHmmss') + '.csv',
    mimeType: 'text/csv',
    content: '﻿' + lines.join('\r\n'),
    rowCount: logs.length,
    filter_label: range.label
  };
}

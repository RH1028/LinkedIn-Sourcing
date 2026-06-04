/**
 * LinkedIn Sourcing — Backend
 * Apps Script bound to the LinkedIn Sourcing DB Google Sheet.
 *
 * Phase 2 step 1: 初始化分頁與欄位。
 * Run `setupSheets()` once after first paste.
 * Re-running is safe — only creates missing sheets / columns, never wipes data.
 */

const SHEET_SCHEMA = {
  Users: [
    'account', 'password', 'role', 'name', 'active', 'created_at',
  ],
  Jobs: [
    'id', 'owner_account', 'title', 'brief', 'jd_text',
    'filter_geography', 'filter_titles', 'filter_industries', 'filter_keywords', 'filter_url',
    'scoring_rubric', 'scoring_rubric_version', 'scoring_rubric_updated_at',
    'status', 'created_at', 'updated_at',
  ],
  Candidates: [
    'id', 'job_id', 'linkedin_url', 'linkedin_url_canonical',
    'name', 'email', 'current_title', 'current_company',
    'tenure_role', 'tenure_company', 'location', 'summary',
    'score', 'score_reason', 'score_rubric_version',
    'dashboard_has_record', 'dashboard_last_contact_at', 'dashboard_status', 'dashboard_pipeline_id',
    'status', 'marked_by', 'marked_at', 'handed_off_at',
    'created_at', 'updated_at',
  ],
  RubricFeedback: [
    'id', 'job_id', 'user_account', 'feedback_text',
    'referenced_candidate_id', 'rubric_before', 'rubric_after', 'created_at',
  ],
  ScheduleConfig: [
    'owner_account', 'daily_cap', 'window_start_hour', 'window_end_hour',
    'weekdays_only', 'blackout_dates', 'min_interval_sec', 'max_interval_sec',
  ],
  SourcingLog: [
    'id', 'owner_account', 'job_id',
    'started_at', 'ended_at',
    'pages_scanned', 'candidates_added', 'candidates_seen', 'notes',
  ],
};

// Role model is flat / SaaS-style:
//   - 'user'  → default for everyone, full sourcing workflow
//   - 'admin' → only the tool owner; same as user PLUS manage Users sheet
// When adding teammates by hand in the Users sheet, set role = 'user'.
const DEFAULT_ADMIN = {
  account: 'rita',
  password: 'admin1234',
  role: 'admin',
  name: 'Rita',
  active: 'yes',
};

const DEFAULT_SCHEDULE = {
  daily_cap: 30,
  window_start_hour: 9,
  window_end_hour: 18,
  weekdays_only: 'yes',
  blackout_dates: '',
  min_interval_sec: 30,
  max_interval_sec: 120,
};

/**
 * One-shot init. Re-runnable.
 * - Creates sheets that don't exist.
 * - Adds header row if empty.
 * - Adds any missing columns to the right (never reorders, never drops).
 * - Seeds default admin user + default ScheduleConfig (if Users / ScheduleConfig are empty).
 */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const summary = [];

  for (const [sheetName, headers] of Object.entries(SHEET_SCHEMA)) {
    let sheet = ss.getSheetByName(sheetName);
    let created = false;
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      created = true;
    }

    const currentRange = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1));
    const currentHeaders = currentRange.getValues()[0].filter((v) => v !== '');

    if (currentHeaders.length === 0) {
      // Empty sheet: write all headers in one shot.
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f0f0f0');
      sheet.setFrozenRows(1);
      summary.push(`${created ? '➕ created' : '🆕 init'} ${sheetName} (${headers.length} cols)`);
    } else {
      // Existing headers: append any missing column to the right.
      const missing = headers.filter((h) => !currentHeaders.includes(h));
      if (missing.length) {
        sheet
          .getRange(1, currentHeaders.length + 1, 1, missing.length)
          .setValues([missing])
          .setFontWeight('bold')
          .setBackground('#f0f0f0');
        summary.push(`➕ ${sheetName} — added ${missing.length} new cols: ${missing.join(', ')}`);
      } else {
        summary.push(`✓ ${sheetName} — already up to date`);
      }
    }
  }

  // Seed default admin if Users is empty.
  const usersSheet = ss.getSheetByName('Users');
  if (usersSheet.getLastRow() === 1) {
    const headers = SHEET_SCHEMA.Users;
    const row = headers.map((h) => {
      if (h === 'created_at') return new Date().toISOString();
      return DEFAULT_ADMIN[h] !== undefined ? DEFAULT_ADMIN[h] : '';
    });
    usersSheet.appendRow(row);
    summary.push(`🔑 seeded default admin (account=${DEFAULT_ADMIN.account}, password=${DEFAULT_ADMIN.password}) — CHANGE IT`);
  }

  // Seed default schedule for the default admin if empty.
  const scheduleSheet = ss.getSheetByName('ScheduleConfig');
  if (scheduleSheet.getLastRow() === 1) {
    const headers = SHEET_SCHEMA.ScheduleConfig;
    const row = headers.map((h) => {
      if (h === 'owner_account') return DEFAULT_ADMIN.account;
      return DEFAULT_SCHEDULE[h] !== undefined ? DEFAULT_SCHEDULE[h] : '';
    });
    scheduleSheet.appendRow(row);
    summary.push(`📅 seeded default schedule for ${DEFAULT_ADMIN.account}`);
  }

  Logger.log(summary.join('\n'));
  SpreadsheetApp.getUi().alert('Setup done:\n\n' + summary.join('\n'));
}

/**
 * Read-only verification. Run after setupSheets to confirm everything is OK.
 */
function verifySetup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lines = [];
  for (const [sheetName, headers] of Object.entries(SHEET_SCHEMA)) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      lines.push(`❌ ${sheetName} — missing`);
      continue;
    }
    const currentHeaders = sheet
      .getRange(1, 1, 1, sheet.getLastColumn())
      .getValues()[0]
      .filter((v) => v !== '');
    const missing = headers.filter((h) => !currentHeaders.includes(h));
    if (missing.length) {
      lines.push(`⚠️ ${sheetName} — missing cols: ${missing.join(', ')}`);
    } else {
      lines.push(`✓ ${sheetName} (${sheet.getLastRow() - 1} rows)`);
    }
  }
  SpreadsheetApp.getUi().alert(lines.join('\n'));
}

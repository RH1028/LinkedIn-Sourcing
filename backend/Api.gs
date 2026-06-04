/**
 * LinkedIn Sourcing — Web API
 *
 * Phase 2 step 2: doGet/doPost entry points + core endpoints + LLM helpers.
 * Requires Code.gs (which holds the schema/setup).
 *
 * To enable LLM-using endpoints, set Script Property ANTHROPIC_API_KEY:
 *   Project Settings (gear icon) → Script Properties → Add property
 *     Name : ANTHROPIC_API_KEY
 *     Value: sk-ant-...
 *
 * Endpoints implemented in this commit:
 *   GET  ?action=me&pw=                          → who am I
 *   GET  ?action=listJobs&pw=                    → my jobs (admin sees all)
 *   GET  ?action=getJob&pw=&id=                  → one job + candidate stats
 *   POST ?action=createJob&pw=    body={brief}   → AI produces JD + filter + rubric
 *   GET  ?action=listCandidates&pw=&job_id=      → candidates for a job
 *   POST ?action=upsertCandidates&pw=  body={job_id, candidates: [...]}
 *                                                → score each via LLM, write rows
 */

// ====================================================================
// Entry points
// ====================================================================

function doGet(e)  { return handleRequest(e, 'GET');  }
function doPost(e) { return handleRequest(e, 'POST'); }

function handleRequest(e, method) {
  const params = (e && e.parameter) || {};
  const action = params.action;
  const pw = params.pw;

  try {
    const user = authenticate(pw);
    if (!user) return jsonResponse({ ok: false, error: 'unauthorized' });

    let body = {};
    if (e && e.postData && e.postData.contents) {
      try { body = JSON.parse(e.postData.contents); } catch (err) { /* ignore */ }
    }
    const payload = Object.assign({}, params, body);

    switch (action) {
      case 'me':
        return jsonResponse({ ok: true, account: user.account, role: user.role, name: user.name });
      case 'listJobs':
        return jsonResponse(apiListJobs(user));
      case 'getJob':
        return jsonResponse(apiGetJob(user, payload));
      case 'createJob':
        return jsonResponse(apiCreateJob(user, payload));
      case 'listCandidates':
        return jsonResponse(apiListCandidates(user, payload));
      case 'upsertCandidates':
        return jsonResponse(apiUpsertCandidates(user, payload));
      default:
        return jsonResponse({ ok: false, error: 'unknown action: ' + action });
    }
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || String(err) });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ====================================================================
// Auth
// ====================================================================

function authenticate(pw) {
  if (!pw) return null;
  const users = readSheet('Users');
  for (const u of users) {
    if (String(u.password) === String(pw) && u.active === 'yes') {
      return { account: u.account, role: u.role, name: u.name };
    }
  }
  return null;
}

function requireRole(user, minRole) {
  const order = { viewer: 0, editor: 1, admin: 2 };
  if ((order[user.role] || -1) < order[minRole]) {
    throw new Error('requires ' + minRole + ' role; you are ' + user.role);
  }
}

// ====================================================================
// Sheet helpers
// ====================================================================

function readSheet(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('sheet not found: ' + name);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

function appendToSheet(name, obj) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const row = headers.map((h) => (obj[h] !== undefined ? obj[h] : ''));
  sheet.appendRow(row);
  return obj;
}

function genId(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 20);
}

function nowIso() {
  return new Date().toISOString();
}

// ====================================================================
// Jobs
// ====================================================================

function apiListJobs(user) {
  const all = readSheet('Jobs');
  const visible = user.role === 'admin'
    ? all
    : all.filter((j) => j.owner_account === user.account);
  return { ok: true, jobs: visible };
}

function apiGetJob(user, payload) {
  const job = readSheet('Jobs').find((j) => j.id === payload.id);
  if (!job) throw new Error('job not found');
  if (user.role !== 'admin' && job.owner_account !== user.account) {
    throw new Error('forbidden');
  }
  const candidates = readSheet('Candidates').filter((c) => c.job_id === job.id);
  const byStatus = {};
  for (const c of candidates) {
    const k = c.status || 'unknown';
    byStatus[k] = (byStatus[k] || 0) + 1;
  }
  return { ok: true, job, stats: { candidate_count: candidates.length, by_status: byStatus } };
}

function apiCreateJob(user, payload) {
  requireRole(user, 'editor');
  if (!payload.brief) throw new Error('brief is required');

  const ai = llmGenerateJobAssets(payload.brief);

  const id = genId('job');
  const now = nowIso();
  const filter = ai.filter || {};
  const job = {
    id,
    owner_account: user.account,
    title: ai.title || 'Untitled',
    brief: payload.brief,
    jd_text: ai.jd_text || '',
    filter_geography: filter.geography || 'Taiwan',
    filter_titles: Array.isArray(filter.titles) ? filter.titles.join(', ') : (filter.titles || ''),
    filter_industries: Array.isArray(filter.industries) ? filter.industries.join(', ') : (filter.industries || ''),
    filter_keywords: filter.keywords || '',
    filter_url: '',
    scoring_rubric: ai.scoring_rubric || '',
    scoring_rubric_version: 1,
    scoring_rubric_updated_at: now,
    status: 'draft',
    created_at: now,
    updated_at: now,
  };
  appendToSheet('Jobs', job);
  return { ok: true, id, job };
}

// ====================================================================
// Candidates
// ====================================================================

function apiListCandidates(user, payload) {
  const jobId = payload.job_id;
  if (!jobId) throw new Error('job_id is required');
  let cands = readSheet('Candidates').filter((c) => c.job_id === jobId);
  if (payload.status) cands = cands.filter((c) => c.status === payload.status);
  const limit = parseInt(payload.limit, 10) || 100;
  const offset = parseInt(payload.offset, 10) || 0;
  const total = cands.length;
  return { ok: true, candidates: cands.slice(offset, offset + limit), total };
}

function apiUpsertCandidates(user, payload) {
  requireRole(user, 'editor');
  const jobId = payload.job_id;
  if (!jobId) throw new Error('job_id is required');
  const job = readSheet('Jobs').find((j) => j.id === jobId);
  if (!job) throw new Error('job not found');

  const existing = readSheet('Candidates').filter((c) => c.job_id === jobId);
  const existingUrls = new Set(existing.map((c) => c.linkedin_url));

  let added = 0;
  let skipped = 0;
  const incoming = Array.isArray(payload.candidates) ? payload.candidates : [];

  for (const c of incoming) {
    if (!c.linkedin_url) { skipped++; continue; }
    if (existingUrls.has(c.linkedin_url)) { skipped++; continue; }

    let scored = { score: 0, reason: '' };
    try {
      scored = llmScoreCandidate(job.scoring_rubric, c);
    } catch (err) {
      scored = { score: 0, reason: 'scoring error: ' + err.message };
    }

    const id = genId('cand');
    const now = nowIso();
    appendToSheet('Candidates', {
      id,
      job_id: jobId,
      linkedin_url: c.linkedin_url,
      linkedin_url_canonical: c.linkedin_url_canonical || '',
      name: c.name || '',
      email: c.email || '',
      current_title: c.current_title || '',
      current_company: c.current_company || '',
      tenure_role: c.tenure_role || '',
      tenure_company: c.tenure_company || '',
      location: c.location || '',
      summary: c.summary || '',
      score: scored.score,
      score_reason: scored.reason,
      score_rubric_version: job.scoring_rubric_version,
      dashboard_has_record: 'no',
      dashboard_last_contact_at: '',
      dashboard_status: '',
      dashboard_pipeline_id: '',
      status: 'new',
      marked_by: '',
      marked_at: '',
      handed_off_at: '',
      created_at: now,
      updated_at: now,
    });
    existingUrls.add(c.linkedin_url);
    added++;
  }
  return { ok: true, added, updated: 0, skipped };
}

// ====================================================================
// LLM (Claude Haiku 4.5)
// ====================================================================

function callClaude(prompt, opts) {
  opts = opts || {};
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in Script Properties');

  const body = {
    model: opts.model || 'claude-haiku-4-5-20251001',
    max_tokens: opts.maxTokens || 2000,
    temperature: opts.temperature === undefined ? 0.2 : opts.temperature,
    messages: [{ role: 'user', content: prompt }],
  };

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  const text = response.getContentText();
  if (code !== 200) throw new Error('Claude API ' + code + ': ' + text.slice(0, 500));

  const json = JSON.parse(text);
  return json.content[0].text;
}

function parseLlmJson(text) {
  let cleaned = String(text).trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '');
  cleaned = cleaned.replace(/\n?```\s*$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
  return JSON.parse(cleaned);
}

function llmGenerateJobAssets(brief) {
  const prompt =
    '你是招募流程顧問。根據職務輪廓，產出 4 項：\n' +
    '1. title — 簡短職稱\n' +
    '2. jd_text — 完整 JD（Markdown，包含工作內容、必要條件、加分條件）\n' +
    '3. filter — LinkedIn Sales Navigator 搜尋條件\n' +
    '4. scoring_rubric — 評分準則（純文字、列點、看得懂）\n\n' +
    '回 JSON：\n' +
    '{\n' +
    '  "title": "...",\n' +
    '  "jd_text": "...",\n' +
    '  "filter": {\n' +
    '    "geography": "Taiwan",\n' +
    '    "titles": ["Recruiter", "Talent Acquisition Specialist"],\n' +
    '    "industries": ["Software Development", "IT Services"],\n' +
    '    "keywords": "..."\n' +
    '  },\n' +
    '  "scoring_rubric": "..."\n' +
    '}\n\n' +
    '職務輪廓：\n' + brief + '\n\n' +
    '只回 JSON，不要前後說明文字。';

  const text = callClaude(prompt, { maxTokens: 3000 });
  return parseLlmJson(text);
}

function llmScoreCandidate(rubric, candidate) {
  const prompt =
    '你是招募評分助手。依下方評分準則，為候選人打分 0–100，並用一兩句話寫理由。\n\n' +
    '評分準則：\n' + (rubric || '(尚未設定)') + '\n\n' +
    '候選人資料：\n' +
    '姓名：' + (candidate.name || '') + '\n' +
    '職稱：' + (candidate.current_title || '') + '\n' +
    '公司：' + (candidate.current_company || '') + '\n' +
    '年資（職位）：' + (candidate.tenure_role || '') + '\n' +
    '年資（公司）：' + (candidate.tenure_company || '') + '\n' +
    '個人簡介：' + (candidate.summary || '') + '\n\n' +
    '只回 JSON：{"score": 75, "reason": "..."}，不要前後說明。';

  const text = callClaude(prompt, { maxTokens: 300 });
  const obj = parseLlmJson(text);
  const score = parseInt(obj.score, 10) || 0;
  return {
    score: Math.max(0, Math.min(100, score)),
    reason: String(obj.reason || ''),
  };
}

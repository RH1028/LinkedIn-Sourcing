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
 * Endpoints:
 *   GET  ?action=me&pw=                          → who am I
 *   GET  ?action=listJobs&pw=                    → all jobs (shared workspace)
 *   GET  ?action=getJob&pw=&id=                  → one job + candidate stats
 *   POST ?action=createJob&pw=  body={title, level, reference_jd, brief}
 *                                                → AI produces jd / filter / rubric
 *   GET  ?action=getJobAssets&pw=&job_id=        → 三產出 + 各自歷史
 *   POST ?action=refineAsset&pw=  body={job_id, target:'jd'|'filter'|'rubric', feedback_text, referenced_candidate_id?}
 *                                                → AI 依意見改寫該產出
 *   POST ?action=updateAsset&pw=  body={job_id, target, text}   → 手動覆蓋該產出
 *   GET  ?action=listCandidates&pw=&job_id=      → candidates for a job
 *   POST ?action=upsertCandidates&pw=  body={job_id, candidates:[...]}  → score + write
 *   POST ?action=rescoreAll&pw=  body={job_id}   → 用現有 rubric 重算全部
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
      case 'updateCandidateStatus':
        return jsonResponse(apiUpdateCandidateStatus(user, payload));
      // 三個 AI 產出（jd / filter / rubric）共用的讀取 / 對話修改 / 手動編輯
      case 'getJobAssets':
        return jsonResponse(apiGetJobAssets(user, payload));
      case 'refineAsset':
        return jsonResponse(apiRefineAsset(user, payload));
      case 'updateAsset':
        return jsonResponse(apiUpdateAsset(user, payload));
      // 舊版 rubric 專用動作 → 轉接到新的泛用函式（向後相容）
      case 'getRubric':
        return jsonResponse(apiGetJobAssets(user, payload));
      case 'refineRubric':
        return jsonResponse(apiRefineAsset(user, Object.assign({ target: 'rubric' }, payload)));
      case 'updateRubric':
        return jsonResponse(apiUpdateAsset(user, { job_id: payload.job_id, target: 'rubric', text: payload.rubric }));
      case 'rescoreAll':
        return jsonResponse(apiRescoreAll(user, payload));
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
  // Two-level model: user (default for everyone) → admin (only the owner).
  // Anything sourcing-workflow related is open to user+; admin is reserved
  // for managing the Users sheet etc.
  const order = { user: 0, admin: 1 };
  const have = order[user.role];
  const need = order[minRole];
  if (have === undefined) throw new Error('unknown role: ' + user.role);
  if (have < need) throw new Error('requires ' + minRole + ' role; you are ' + user.role);
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
  // Shared workspace: all authenticated users see all jobs (no per-job owner).
  const all = readSheet('Jobs');
  return { ok: true, jobs: all };
}

function apiGetJob(user, payload) {
  const job = readSheet('Jobs').find((j) => j.id === payload.id);
  if (!job) throw new Error('job not found');
  const candidates = readSheet('Candidates').filter((c) => c.job_id === job.id);
  const byStatus = {};
  for (const c of candidates) {
    const k = c.status || 'unknown';
    byStatus[k] = (byStatus[k] || 0) + 1;
  }
  return { ok: true, job, stats: { candidate_count: candidates.length, by_status: byStatus } };
}

function apiCreateJob(user, payload) {
  requireRole(user, 'user');
  // 使用者填的 4 欄：職務名稱(必)、職級(必)、參考 JD(可選)、職務關鍵(必)
  const title = (payload.title || '').toString().trim();
  const level = (payload.level || '').toString().trim();
  const brief = (payload.brief || '').toString().trim();
  const referenceJd = (payload.reference_jd || '').toString().trim();
  if (!title) throw new Error('職務名稱必填');
  if (!brief) throw new Error('職務關鍵必填');

  const ai = llmGenerateJobAssets({ title: title, level: level, reference_jd: referenceJd, brief: brief });

  const id = genId('job');
  const now = nowIso();
  const job = {
    id,
    title: title,
    level: level,
    reference_jd: referenceJd,
    brief: brief,
    jd_text: ai.jd_text || '',
    jd_updated_at: now,
    filter_text: ai.filter_text || '',
    filter_url: ai.filter_url || '',
    filter_updated_at: now,
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
  requireRole(user, 'user');
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

// 從使用者填的 4 欄產出三樣成品
function llmGenerateJobAssets(input) {
  const prompt =
    '你是資深招募/獵才顧問。根據下方職務資訊，產出三樣成品。\n\n' +
    '【職務名稱】' + (input.title || '') + '\n' +
    '【職級】' + (input.level || '(未指定)') + '\n' +
    '【職務關鍵（使用者的核心需求描述）】\n' + (input.brief || '') + '\n' +
    (input.reference_jd ? ('【參考 JD（既有版本，當風格與內容範本，可改寫）】\n' + input.reference_jd + '\n') : '') +
    '\n要產出的三樣：\n' +
    '1. jd_text — 完整 JD（Markdown，含「職務 title、工作內容說明、必要條件、加分條件」四段）\n' +
    '2. filter_text — 你建議在 LinkedIn 上 sourcing 的搜尋條件（純文字、列點寫：地區 / 目標職稱關鍵字 / 產業 / 現職或過往公司類型 / 必含或排除關鍵字）\n' +
    '3. filter_url — 依上面條件組出的 LinkedIn 一般搜尋網址（https://www.linkedin.com/search/results/people/?keywords=... ，把關鍵字 URL-encode）\n' +
    '4. scoring_rubric — 評分準則（純文字、列點、可直接拿來幫人選打分）\n\n' +
    '回 JSON（只回 JSON，不要前後說明文字）：\n' +
    '{\n' +
    '  "jd_text": "...",\n' +
    '  "filter_text": "...",\n' +
    '  "filter_url": "https://www.linkedin.com/search/results/people/?keywords=...",\n' +
    '  "scoring_rubric": "..."\n' +
    '}';

  const text = callClaude(prompt, { maxTokens: 3500 });
  return parseLlmJson(text);
}

// 跟 AI 對話修改某個產出，回 { text, url? }
function llmRefineAsset(target, job, currentText, feedback, candidateContext) {
  if (target === 'rubric') {
    return { text: llmRefineRubric(currentText, feedback, candidateContext) };
  }

  const jobCtx =
    '【職務名稱】' + (job.title || '') + '　【職級】' + (job.level || '(未指定)') + '\n' +
    '【職務關鍵】' + (job.brief || '') + '\n';

  if (target === 'jd') {
    const prompt =
      '你是招募顧問。下面是某職缺「目前的 JD」和「使用者剛給的修改意見」。\n' +
      '請依意見改寫，保留沒被質疑、仍合理的內容，維持「職務 title / 工作內容 / 必要條件 / 加分條件」四段的 Markdown 格式。\n' +
      '只回新版 JD 本文，不要前後說明、不要解釋改了什麼。\n\n' +
      jobCtx + '\n目前 JD：\n' + (currentText || '(尚未產生)') + '\n\n使用者意見：' + feedback + '\n\n直接輸出新版 JD：';
    return { text: callClaude(prompt, { maxTokens: 3000, temperature: 0.3 }) };
  }

  // target === 'filter'
  const prompt =
    '你是 LinkedIn sourcing 專家。下面是某職缺「目前的搜尋條件」和「使用者剛給的修改意見」。\n' +
    '請依意見改寫搜尋條件，並重新組出對應的 LinkedIn 一般搜尋網址。\n' +
    '回 JSON（只回 JSON）：{ "filter_text": "...", "filter_url": "https://www.linkedin.com/search/results/people/?keywords=..." }\n\n' +
    jobCtx + '\n目前搜尋條件：\n' + (currentText || '(尚未產生)') + '\n\n使用者意見：' + feedback + '\n\n直接輸出 JSON：';
  const obj = parseLlmJson(callClaude(prompt, { maxTokens: 1500, temperature: 0.3 }));
  return { text: obj.filter_text || currentText, url: obj.filter_url || '' };
}

// 手動改完搜尋條件文字後，重新派生搜尋網址
function llmBuildFilterUrl(filterText, job) {
  try {
    const prompt =
      '把下面這段 LinkedIn 搜尋條件，組成一個 LinkedIn 一般搜尋網址。\n' +
      '只回網址一行，格式 https://www.linkedin.com/search/results/people/?keywords=... （關鍵字要 URL-encode），不要任何其他文字。\n\n' +
      '搜尋條件：\n' + filterText;
    const out = String(callClaude(prompt, { maxTokens: 400, temperature: 0 })).trim();
    const m = out.match(/https?:\/\/\S+/);
    return m ? m[0] : (job && job.filter_url) || '';
  } catch (err) {
    return (job && job.filter_url) || '';
  }
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

// ====================================================================
// Update helpers — patch a single row by id
// ====================================================================

function updateJobRow(jobId, updates) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Jobs');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idIdx = headers.indexOf('id');
  for (let r = 1; r < data.length; r++) {
    if (data[r][idIdx] === jobId) {
      for (const key in updates) {
        const colIdx = headers.indexOf(key);
        if (colIdx >= 0) sheet.getRange(r + 1, colIdx + 1).setValue(updates[key]);
      }
      return;
    }
  }
  throw new Error('job not found: ' + jobId);
}

function updateCandidateRow(candidateId, updates) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Candidates');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idIdx = headers.indexOf('id');
  for (let r = 1; r < data.length; r++) {
    if (data[r][idIdx] === candidateId) {
      for (const key in updates) {
        const colIdx = headers.indexOf(key);
        if (colIdx >= 0) sheet.getRange(r + 1, colIdx + 1).setValue(updates[key]);
      }
      return;
    }
  }
  throw new Error('candidate not found: ' + candidateId);
}

// ====================================================================
// Candidate status
// ====================================================================

function apiUpdateCandidateStatus(user, payload) {
  requireRole(user, 'user');
  if (!payload.id) throw new Error('id is required');
  if (!payload.status) throw new Error('status is required');
  updateCandidateRow(payload.id, {
    status: payload.status,
    marked_by: user.account,
    marked_at: nowIso(),
    updated_at: nowIso(),
  });
  return { ok: true };
}

// ====================================================================
// 三個 AI 產出（jd / filter / rubric）：讀取 / 對話修改(LLM) / 手動編輯
// ====================================================================

// 每個 target 對應到 Jobs 分頁的哪些欄位
const ASSET_FIELDS = {
  jd:     { text: 'jd_text',        updated_at: 'jd_updated_at' },
  filter: { text: 'filter_text',    updated_at: 'filter_updated_at', url: 'filter_url' },
  rubric: { text: 'scoring_rubric', updated_at: 'scoring_rubric_updated_at', version: 'scoring_rubric_version' },
};

function assetCfg(target) {
  const cfg = ASSET_FIELDS[target];
  if (!cfg) throw new Error('unknown asset target: ' + target + '（只能是 jd / filter / rubric）');
  return cfg;
}

// 讀一個職缺的三個產出 + 各自的歷史
function apiGetJobAssets(user, payload) {
  const job = readSheet('Jobs').find(function (j) { return j.id === payload.job_id; });
  if (!job) throw new Error('job not found');

  const all = readSheet('JobFeedback')
    .filter(function (f) { return f.job_id === payload.job_id; })
    .sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
  const history = { jd: [], filter: [], rubric: [] };
  for (const f of all) {
    const t = f.target || 'rubric';
    if (history[t]) history[t].push(f);
  }

  return {
    ok: true,
    job_id: job.id,
    assets: {
      jd:     { text: job.jd_text || '',        updated_at: job.jd_updated_at || '' },
      filter: { text: job.filter_text || '',    url: job.filter_url || '', updated_at: job.filter_updated_at || '' },
      rubric: { text: job.scoring_rubric || '', version: job.scoring_rubric_version || 1, updated_at: job.scoring_rubric_updated_at || '' },
    },
    history: history,
    // 向後相容：舊 UI 仍讀 rubric / version / history 這三個頂層欄位
    rubric: job.scoring_rubric,
    version: job.scoring_rubric_version,
    updated_at: job.scoring_rubric_updated_at,
  };
}

// 跟 AI 對話修改某個產出
function apiRefineAsset(user, payload) {
  requireRole(user, 'user');
  const target = payload.target || 'rubric';
  const cfg = assetCfg(target);
  if (!payload.feedback_text) throw new Error('feedback_text is required');
  const job = readSheet('Jobs').find(function (j) { return j.id === payload.job_id; });
  if (!job) throw new Error('job not found');

  const before = job[cfg.text] || '';

  // 只有評分準則的對話可以「針對某位候選人」
  let candidateContext = '';
  if (target === 'rubric' && payload.referenced_candidate_id) {
    const c = readSheet('Candidates').find(function (x) { return x.id === payload.referenced_candidate_id; });
    if (c) {
      candidateContext = '\n\n（這條回饋是針對候選人 ' + c.name + '，職稱 ' + c.current_title +
        '，公司 ' + c.current_company + '，目前評分 ' + c.score + ' 分，原評分理由：' + c.score_reason + '）';
    }
  }

  const after = llmRefineAsset(target, job, before, payload.feedback_text, candidateContext);
  const now = nowIso();
  const updates = {};
  updates[cfg.text] = after.text;
  updates[cfg.updated_at] = now;
  updates.updated_at = now;
  if (cfg.url) updates[cfg.url] = after.url || '';
  if (cfg.version) updates[cfg.version] = (parseInt(job[cfg.version], 10) || 1) + 1;

  updateJobRow(payload.job_id, updates);
  appendAssetFeedback(payload.job_id, target, user.account, payload.feedback_text, payload.referenced_candidate_id || '', before, after.text, now);

  return {
    ok: true,
    target: target,
    before_text: before,
    after_text: after.text,
    url: after.url,
    version: cfg.version ? updates[cfg.version] : undefined,
  };
}

// 手動覆蓋某個產出
function apiUpdateAsset(user, payload) {
  requireRole(user, 'user');
  const target = payload.target || 'rubric';
  const cfg = assetCfg(target);
  if (payload.text === undefined) throw new Error('text is required');
  const job = readSheet('Jobs').find(function (j) { return j.id === payload.job_id; });
  if (!job) throw new Error('job not found');

  const before = job[cfg.text] || '';
  const now = nowIso();
  const updates = {};
  updates[cfg.text] = payload.text;
  updates[cfg.updated_at] = now;
  updates.updated_at = now;
  // 手動改搜尋條件文字 → 重新派生搜尋網址
  if (cfg.url) updates[cfg.url] = llmBuildFilterUrl(payload.text, job);
  if (cfg.version) updates[cfg.version] = (parseInt(job[cfg.version], 10) || 1) + 1;

  updateJobRow(payload.job_id, updates);
  appendAssetFeedback(payload.job_id, target, user.account, '(manual edit)', '', before, payload.text, now);

  return { ok: true, target: target, version: cfg.version ? updates[cfg.version] : undefined };
}

function appendAssetFeedback(jobId, target, account, feedbackText, refCandidateId, beforeText, afterText, now) {
  appendToSheet('JobFeedback', {
    id: genId('fb'),
    job_id: jobId,
    target: target,
    user_account: account,
    feedback_text: feedbackText,
    referenced_candidate_id: refCandidateId,
    before_text: beforeText,
    after_text: afterText,
    created_at: now,
  });
}

function apiRescoreAll(user, payload) {
  requireRole(user, 'user');
  const job = readSheet('Jobs').find(function (j) { return j.id === payload.job_id; });
  if (!job) throw new Error('job not found');

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Candidates');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const jobIdIdx = headers.indexOf('job_id');
  const scoreIdx = headers.indexOf('score');
  const reasonIdx = headers.indexOf('score_reason');
  const versionIdx = headers.indexOf('score_rubric_version');
  const updatedAtIdx = headers.indexOf('updated_at');

  let scored = 0;
  let failed = 0;
  for (let r = 1; r < data.length; r++) {
    if (data[r][jobIdIdx] !== payload.job_id) continue;
    const candidate = {};
    headers.forEach(function (h, i) { candidate[h] = data[r][i]; });
    try {
      const s = llmScoreCandidate(job.scoring_rubric, candidate);
      sheet.getRange(r + 1, scoreIdx + 1).setValue(s.score);
      sheet.getRange(r + 1, reasonIdx + 1).setValue(s.reason);
      sheet.getRange(r + 1, versionIdx + 1).setValue(job.scoring_rubric_version);
      sheet.getRange(r + 1, updatedAtIdx + 1).setValue(nowIso());
      scored++;
    } catch (err) {
      failed++;
    }
  }
  return { ok: true, scored_count: scored, failed: failed };
}

// ====================================================================
// LLM: rubric refinement
// ====================================================================

function llmRefineRubric(currentRubric, feedback, candidateContext) {
  const prompt =
    '你是招募評分顧問。下面是「目前的評分準則」和「使用者剛給的回饋」。\n' +
    '請根據回饋，產出「新版評分準則」。\n\n' +
    '原則：\n' +
    '- 保留沒被質疑、仍合理的條目\n' +
    '- 修正、刪除、或新增條目以反映 feedback\n' +
    '- 保持「列點、看得懂、可直接拿來打分」的格式\n' +
    '- 只回新版評分準則本文，不要前後說明文字、不要解釋改了什麼\n\n' +
    '目前評分準則：\n' + (currentRubric || '(尚未設定)') + '\n\n' +
    '使用者回饋：' + feedback + (candidateContext || '') + '\n\n' +
    '直接輸出新版評分準則：';

  return callClaude(prompt, { maxTokens: 2000, temperature: 0.3 });
}

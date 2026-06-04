# LinkedIn Sourcing — Contract

> Status: Phase 1 鎖定，2026-06-04。所有 UI / Extension / Backend 開發**必須遵守本文件介面定義**，介面變動才動本文件。

## 決策摘要（MVP 邊界）

| 決策 | 選擇 | 理由 |
|---|---|---|
| Backend | Apps Script + Google Sheet（獨立 Sheet） | 重用 recruit-dashboard 經驗、零部署成本、5 人量級綽綽有餘 |
| 認證 | 重用 recruit-dashboard 三級權限模式（明碼密碼、Users 分頁） | 一致學習曲線、新人只要加一行 |
| 評分 | 規則式（產業/年資/blurb 關鍵字） | MVP 先有；LLM 之後可掛 |
| 使用者 | 支援 1–5 人 | 跟 recruit-dashboard 同套機制 |
| 職缺 | 多職缺，**每使用者排程一次跑一個 job** | 避免並發抓取觸發 LinkedIn 偵測 |

## 1. 資料模型

獨立 Google Sheet（暫稱 `LinkedIn Sourcing DB`），分頁如下：

### `Users` 分頁

跟 recruit-dashboard 同欄位、密碼明碼。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `account` | string | 使用者代號（與 LinkedIn 帳號無關，純識別） |
| `password` | string | 明碼，管理者在 Sheet 直接編 |
| `role` | enum | `viewer` / `editor` / `admin` |
| `name` | string | 顯示用 |
| `active` | enum | `yes` / `no` |
| `created_at` | datetime | ISO 8601 |

### `Jobs` 分頁

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | string | `job_` 前綴 + ULID |
| `owner_account` | string | FK → `Users.account`，誰負責這個 job |
| `title` | string | 職缺名稱（例：資深人才招募專員） |
| `jd_text` | text | 完整 JD（系統產 + 使用者編） |
| `filter_geography` | string | 例：`Taiwan` |
| `filter_titles` | string | 逗號分隔，例：`Recruiter,Talent Acquisition Specialist` |
| `filter_industries` | string | 逗號分隔，例：`Software Development,IT Services` |
| `filter_keywords` | string | 自由文字 |
| `filter_url` | string | 對應的 Sales Nav URL（Extension 直接用） |
| `status` | enum | `draft` / `active` / `paused` / `closed` |
| `created_at` / `updated_at` | datetime | |

### `Candidates` 分頁

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | string | `cand_` + ULID |
| `job_id` | string | FK → `Jobs.id` |
| `linkedin_url` | string | Sales Nav profile URL（去掉 query string） |
| `linkedin_url_canonical` | string | 公開 `linkedin.com/in/...` URL，可能空 |
| `name` | string | |
| `current_title` | string | |
| `current_company` | string | |
| `tenure_role` | string | 例：`5 years 2 months` |
| `tenure_company` | string | |
| `location` | string | |
| `blurb` | text | 個人簡介前段 |
| `score` | int | 0–100，規則式產出（見第 4 節） |
| `score_reason` | text | 評分依據摘要 |
| `status` | enum | `new` / `shortlisted` / `contacted` / `responded` / `rejected` / `handed_off` |
| `marked_by` | string | 使用者標記時 → `Users.account` |
| `marked_at` | datetime | |
| `handed_off_at` | datetime | 送進 recruit-dashboard 時 |
| `created_at` / `updated_at` | datetime | |

**Unique constraint：** `(job_id, linkedin_url)` 不重複（Extension 重複抓不會新增）。

### `ScheduleConfig` 分頁

| 欄位 | 型別 | 說明 |
|---|---|---|
| `owner_account` | string | FK → `Users.account`，主鍵 |
| `daily_cap` | int | 預設 30，最大 50 |
| `window_start_hour` | int | 0–23，例：9 |
| `window_end_hour` | int | 0–23，例：18 |
| `weekdays_only` | bool | 預設 true |
| `blackout_dates` | string | ISO date 逗號分隔，例：`2026-06-10,2026-06-11` |
| `min_interval_sec` | int | 預設 30 |
| `max_interval_sec` | int | 預設 120 |

### `SourcingLog` 分頁（稽核用）

| 欄位 | 說明 |
|---|---|
| `id` | log ID |
| `owner_account` | 誰跑的 |
| `job_id` | 哪個 job |
| `started_at` / `ended_at` | |
| `pages_scanned` | int |
| `candidates_added` | int |
| `candidates_seen` | int（含重複） |
| `notes` | 錯誤、警告等 |

## 2. API（Apps Script Web App）

**Base URL：** Apps Script 部署後給的 `https://script.google.com/macros/s/.../exec`

**所有請求都帶 `pw=<密碼>`**（重用 recruit-dashboard 機制）。後端 `roleForPw()` 決定能不能做。

**回應格式：** 一律 JSON。錯誤 `{ ok: false, error: "..." }`，成功 `{ ok: true, ... }`。

### 認證 / 配置

| Method | Endpoint | 角色 | 說明 |
|---|---|---|---|
| GET | `?action=me&pw=` | any | 回 `{ ok, account, role, name }`，密碼錯回 `{ ok:false, error:"unauthorized" }` |

### Jobs

| Method | Endpoint | 角色 | Payload | 回應 |
|---|---|---|---|---|
| GET | `?action=listJobs&pw=` | viewer+ | (none) | `{ ok, jobs: Job[] }`（只回自己的 + admin 看全部） |
| GET | `?action=getJob&pw=&id=` | viewer+ | (none) | `{ ok, job: Job, stats: { candidate_count, by_status } }` |
| POST | `?action=createJob&pw=` | editor+ | `{ title, jd_text, filter_* }` | `{ ok, id }` |
| POST | `?action=updateJob&pw=` | editor+ | `{ id, ...partial }` | `{ ok }` |

### Candidates

| Method | Endpoint | 角色 | Payload | 回應 |
|---|---|---|---|---|
| GET | `?action=listCandidates&pw=&job_id=&status=&limit=&offset=` | viewer+ | (none) | `{ ok, candidates: Candidate[], total }` |
| POST | `?action=upsertCandidates&pw=` | editor+ | `{ job_id, candidates: ExtractedCandidate[] }` | `{ ok, added, updated, skipped }` |
| POST | `?action=updateCandidateStatus&pw=` | editor+ | `{ id, status, note? }` | `{ ok }` |
| POST | `?action=handoffCandidate&pw=` | editor+ | `{ id }` | `{ ok, dashboard_response }` — 呼叫 recruit-dashboard handoff、寫 `handed_off_at` |

### Schedule

| Method | Endpoint | 角色 | Payload | 回應 |
|---|---|---|---|---|
| GET | `?action=getSchedule&pw=` | viewer+ | (none) | `{ ok, config: ScheduleConfig }` |
| POST | `?action=updateSchedule&pw=` | editor+ | `{ ...ScheduleConfig fields }` | `{ ok }` |
| GET | `?action=getActiveJob&pw=` | viewer+ | (none) | **Extension 開機問**：「現在我該跑哪個 job？」回 `{ ok, job: Job \| null, next_run_at }`，會看當下時段、blackout、是否在排程時間內 |

### 形狀定義

```typescript
// Extension scrape 出來的原始格式
interface ExtractedCandidate {
  linkedin_url: string;      // Sales Nav 連結
  name: string;
  current_title: string;
  current_company: string;
  tenure_role: string;       // raw "X years Y months"
  tenure_company: string;
  location: string;
  blurb: string;
}

// 後端評分後加上：
interface Candidate extends ExtractedCandidate {
  id: string;
  job_id: string;
  score: number;
  score_reason: string;
  status: 'new' | 'shortlisted' | 'contacted' | 'responded' | 'rejected' | 'handed_off';
  marked_by?: string;
  marked_at?: string;
  handed_off_at?: string;
  created_at: string;
  updated_at: string;
}
```

## 3. recruit-dashboard Handoff

**單向：sourcing → dashboard。**

**呼叫端：** 本系統後端 Apps Script（`handoffCandidate` 內部呼叫）
**接收端：** recruit-dashboard 後端要新增 endpoint `?action=addCandidate`

### Request（sourcing → dashboard）

```http
POST {dashboard_url}?action=addCandidate
Content-Type: application/json

{
  "pw": "<sourcing 系統的服務密碼>",
  "name": "Alice Ho",
  "linkedin_url": "https://www.linkedin.com/in/...",
  "source": "LinkedIn Sourcing",
  "job_ref": "JIRA690",
  "current_title": "Talent Partner",
  "current_company": "Ubiquiti Inc.",
  "score": 92,
  "notes": "10y tech recruiter, agency+in-house"
}
```

### Response

```json
{ "ok": true, "pipeline_id": "P123" }
```

或

```json
{ "ok": false, "error": "duplicate", "existing_pipeline_id": "P89" }
```

### dashboard 端動作

1. 驗 `pw`（admin 級）
2. 寫入 dashboard 的 `Pipeline` 分頁，`stage = "Sourcing"`、`src = "LinkedIn"`
3. 回 pipeline ID

## 4. 評分演算法（規則式 v1）

`score = 50 + sum(rules)` 截斷在 0–100。

### 加分（+）

| 條件 | 分數 |
|---|---|
| `current_company` 在大廠白名單（Google, Meta, Microsoft, AMD, Trend Micro, Ubiquiti, AWS, NVIDIA, …） | +15 |
| `tenure_role` 解析 ≥ 3 年 | +10 |
| `tenure_role` 解析 ≥ 5 年 | +5（疊加） |
| `blurb` 命中關鍵字 `Talent Acquisition` / `Technical Recruiter` / `full-cycle` / `sourcing` | 每個 +5（上限 +15） |
| `blurb` 提及 `AI` / `agent` / `automation`（CMoney 加分條件） | +10 |
| `blurb` 寫到 `looking for` / `open to` / `new opportunity` | +20（主動找工作信號） |

### 扣分（–）

| 條件 | 分數 |
|---|---|
| `current_company` 在傳產/不相關白名單（食品、零售、純機械） | –15 |
| `tenure_role` < 6 個月 | –10 |
| `name` 像公司帳號（含 `HR` / `Recruiter` 結尾且 `company == name`） | –50（基本剔除） |
| `blurb` 空白 | –5 |

**`score_reason`** 欄位寫成可讀句：`"+15 大廠(Google) +10 5+yr +5 software"` 之類。

### 演算法 v2（未來）

`score_v1` 留底，疊一支 LLM scorer 比對是否一致；穩定後再切。

## 5. 開發優先序（Phase 2 MVP）

按這個順序開發、隨時可暫停 demo：

1. **Backend MVP** — 建 Sheet、`me` / `listJobs` / `createJob` / `upsertCandidates` / `listCandidates` 五支 API
2. **Extension v0.1** — 開啟 UI 給 job ID、scan 當前頁、POST 到 Backend
3. **UI v0.1**（一頁式）— 列 jobs、進 job 看候選人卡片、勾「可聯繫」→ status 改 `shortlisted`
4. **Schedule** — `getActiveJob` + Extension polling 排程
5. **Scoring** — 規則式評分套上
6. **Handoff** — recruit-dashboard `addCandidate` endpoint + 本系統 `handoffCandidate`
7. **Polish** — schedule UI、SourcingLog、稽核

## 6. 已知尚待釐清（不擋 MVP）

- LLM scorer：用什麼模型、跑在哪（Apps Script 內部呼叫 Claude API？）
- 排程 trigger：靠 Extension polling 還是 Apps Script time-driven trigger 推給 Extension？目前假設**前者**（Extension 開機定期 GET `getActiveJob`）
- 候選人去重的進階規則（同人換工作會不會被當不同人？）

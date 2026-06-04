# LinkedIn Sourcing — Contract

> Status: Phase 1 鎖定 v2，2026-06-04。所有 UI / Extension / Backend 開發**必須遵守本文件介面定義**，介面變動才動本文件。

## 決策摘要（MVP 邊界）

| 決策 | 選擇 | 理由 |
|---|---|---|
| Backend | Apps Script + Google Sheet（獨立 Sheet） | 重用 recruit-dashboard 經驗、零部署成本、5 人量級綽綽有餘 |
| 認證 | 明碼密碼、Users 分頁。**兩級權限：`user` / `admin`**（不是 recruit-dashboard 那套三級） | 工具型系統：成員都該能跑全流程，只有 owner 需要 admin |
| 資料可見性 | **共用工作區**：所有 user 看得到所有 jobs / candidates / rubrics | 真實 sourcing 是團隊協作場景，不是個人記事本 |
| 評分 | **AI（LLM）動態評分**，rubric 文字存在 Job、可學習 | 不寫死規則、每個 JD 客製、使用者 feedback 會更新 rubric |
| 評分 UI | 內部 0–100、UI 顯示 5 星（每 20 分一顆） | 簡單直觀 |
| Rubric 重算 | 預設不自動，給「重算所有人」按鈕 | 使用者控制 |
| 使用者 | 支援 1–5 人 | 跟 recruit-dashboard 同套機制 |
| 職缺 | 多職缺，**每使用者排程一次跑一個 job** | 避免並發抓取觸發 LinkedIn 偵測 |
| 跟 recruit-dashboard 整合 | 雙向：sourcing 抓到候選人時 query dashboard 是否有歷史；shortlist 後 push dashboard | dashboard 是「聯繫紀錄真實來源」 |

## 1. 資料模型

獨立 Google Sheet（暫稱 `LinkedIn Sourcing DB`），分頁如下：

### `Users` 分頁

跟 recruit-dashboard 同欄位、密碼明碼。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `account` | string | 使用者代號（與 LinkedIn 帳號無關，純識別） |
| `password` | string | 明碼，管理者在 Sheet 直接編 |
| `role` | enum | `user`（預設、可跑全工作流）/ `admin`（同 user + 管 Users 分頁）|
| `name` | string | 顯示用 |
| `active` | enum | `yes` / `no` |
| `created_at` | datetime | ISO 8601 |

### `Jobs` 分頁

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | string | `job_` 前綴 + ULID |
| `owner_account` | string | FK → `Users.account`，誰負責這個 job |
| `title` | string | 職缺名稱 |
| `brief` | text | 使用者一開始輸入的「職務輪廓」原文（建立用） |
| `jd_text` | text | AI 產出的完整 JD（使用者可編） |
| `filter_geography` | string | 例：`Taiwan` |
| `filter_titles` | string | 逗號分隔，例：`Recruiter,Talent Acquisition Specialist` |
| `filter_industries` | string | 逗號分隔，例：`Software Development,IT Services` |
| `filter_keywords` | string | 自由文字 |
| `filter_url` | string | 對應的 Sales Nav URL |
| `scoring_rubric` | text | **AI 產出的評分準則文字（可學習）**；初版由 brief 推導，每次 feedback 會被改寫 |
| `scoring_rubric_version` | int | 從 1 開始，每次更新 +1 |
| `scoring_rubric_updated_at` | datetime | |
| `status` | enum | `draft` / `active` / `paused` / `closed` |
| `created_at` / `updated_at` | datetime | |

### `Candidates` 分頁

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | string | `cand_` + ULID |
| `job_id` | string | FK → `Jobs.id` |
| `linkedin_url` | string | Sales Nav profile URL（去 query string） |
| `linkedin_url_canonical` | string | 公開 `linkedin.com/in/...`，可能空 |
| `name` | string | |
| `email` | string | 撈到就填、撈不到空白 |
| `current_title` | string | |
| `current_company` | string | |
| `tenure_role` | string | 例：`5 years 2 months` |
| `tenure_company` | string | |
| `location` | string | |
| `summary` | text | 個人簡介前段（原 blurb 改名） |
| `score` | int | 0–100，AI 評分 |
| `score_reason` | text | AI 寫的可讀理由 |
| `score_rubric_version` | int | 評分時用的 `scoring_rubric_version`，方便追溯 |
| `dashboard_has_record` | bool | recruit-dashboard 內有沒有此人 |
| `dashboard_last_contact_at` | datetime | 上次聯繫日（從 dashboard 撈回） |
| `dashboard_status` | string | 當時狀態（從 dashboard 撈回） |
| `dashboard_pipeline_id` | string | dashboard 的 pipeline 紀錄 ID |
| `status` | enum | `new` / `shortlisted` / `contacted` / `responded` / `rejected` / `handed_off` |
| `marked_by` | string | 使用者標記時 → `Users.account` |
| `marked_at` | datetime | |
| `handed_off_at` | datetime | |
| `created_at` / `updated_at` | datetime | |

**Unique constraint：** `(job_id, linkedin_url)` 不重複。

### `RubricFeedback` 分頁（評分準則的對話歷史）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | string | `fb_` + ULID |
| `job_id` | string | FK → `Jobs.id` |
| `user_account` | string | 誰給的 feedback |
| `feedback_text` | text | 使用者說的話原文（例：「Alice 評太高，她沒 AI 經驗」） |
| `referenced_candidate_id` | string | 若 feedback 是針對特定候選人，記下來；否則空 |
| `rubric_before` | text | 改前的 `scoring_rubric` 完整內容（快照） |
| `rubric_after` | text | 改後的 `scoring_rubric` 完整內容（快照） |
| `created_at` | datetime | |

### `ScheduleConfig` 分頁

| 欄位 | 型別 | 說明 |
|---|---|---|
| `owner_account` | string | FK → `Users.account`，主鍵 |
| `daily_cap` | int | 預設 30，最大 50 |
| `window_start_hour` | int | 0–23，例：9 |
| `window_end_hour` | int | 0–23，例：18 |
| `weekdays_only` | bool | 預設 true |
| `blackout_dates` | string | ISO date 逗號分隔 |
| `min_interval_sec` | int | 預設 30 |
| `max_interval_sec` | int | 預設 120 |

### `SourcingLog` 分頁（稽核）

| 欄位 | 說明 |
|---|---|
| `id` | log ID |
| `owner_account` | 誰跑的 |
| `job_id` | 哪個 job |
| `started_at` / `ended_at` | |
| `pages_scanned` | int |
| `candidates_added` | int |
| `candidates_seen` | int（含重複） |
| `notes` | 錯誤、警告 |

## 2. API（Apps Script Web App）

**Base URL：** `https://script.google.com/macros/s/.../exec`
**所有請求都帶 `pw=<密碼>`**。後端 `roleForPw()` 決定能不能做。
**回應格式：** JSON，錯誤 `{ ok: false, error }`、成功 `{ ok: true, ... }`。

### 認證

| Method | Endpoint | 角色 | 回應 |
|---|---|---|---|
| GET | `?action=me&pw=` | any | `{ ok, account, role, name }` |

### Jobs

| Method | Endpoint | 角色 | Payload | 回應 |
|---|---|---|---|---|
| GET | `?action=listJobs&pw=` | user+ | — | `{ ok, jobs }` |
| GET | `?action=getJob&pw=&id=` | user+ | — | `{ ok, job, stats }` |
| POST | `?action=createJob&pw=` | user+ | `{ brief }` | `{ ok, id, jd_text, filter_*, scoring_rubric }` — **後端 call LLM 產 JD + filter + rubric** |
| POST | `?action=updateJob&pw=` | user+ | `{ id, ...partial }` | `{ ok }` |

### Candidates

| Method | Endpoint | 角色 | Payload | 回應 |
|---|---|---|---|---|
| GET | `?action=listCandidates&pw=&job_id=&status=&limit=&offset=` | user+ | — | `{ ok, candidates, total }` |
| POST | `?action=upsertCandidates&pw=` | user+ | `{ job_id, candidates: ExtractedCandidate[] }` | `{ ok, added, updated, skipped }` — **後端對每筆新候選人 (1) lookup dashboard (2) call LLM 評分** |
| POST | `?action=updateCandidateStatus&pw=` | user+ | `{ id, status, note? }` | `{ ok }` |
| POST | `?action=handoffCandidate&pw=` | user+ | `{ id }` | `{ ok, dashboard_response }` |

### Rubric（AI 評分準則學習）

| Method | Endpoint | 角色 | Payload | 回應 |
|---|---|---|---|---|
| GET | `?action=getRubric&pw=&job_id=` | user+ | — | `{ ok, rubric, version, history: RubricFeedback[] }` |
| POST | `?action=refineRubric&pw=` | user+ | `{ job_id, feedback_text, referenced_candidate_id? }` | `{ ok, rubric_before, rubric_after, version }` — **call LLM 把 feedback 吃進去、更新 rubric、寫 RubricFeedback** |
| POST | `?action=updateRubric&pw=` | user+ | `{ job_id, rubric }` | `{ ok, version }` — **使用者手動編 rubric** |
| POST | `?action=rescoreAll&pw=` | user+ | `{ job_id }` | `{ ok, scored_count }` — **用最新 rubric 重算所有候選人** |

### Schedule

| Method | Endpoint | 角色 | Payload | 回應 |
|---|---|---|---|---|
| GET | `?action=getSchedule&pw=` | user+ | — | `{ ok, config }` |
| POST | `?action=updateSchedule&pw=` | user+ | `{ ...fields }` | `{ ok }` |
| GET | `?action=getActiveJob&pw=` | user+ | — | Extension 用：「現在我該跑哪個 job？」回 `{ ok, job, next_run_at }` |

### 形狀定義

```typescript
interface ExtractedCandidate {
  linkedin_url: string;
  linkedin_url_canonical?: string;
  name: string;
  email?: string;
  current_title: string;
  current_company: string;
  tenure_role: string;
  tenure_company: string;
  location: string;
  summary: string;
  connection_degree?: '1st' | '2nd' | '3rd';
}
```

## 3. recruit-dashboard 雙向 mapping

跟 recruit-dashboard 是兩條路：

### 3.1 Lookup（sourcing → dashboard 查歷史）

**時機：** 每次 `upsertCandidates` 抓到新候選人時，後端對每筆呼叫一次。

```http
GET {dashboard_url}?action=lookupCandidate&pw=&linkedin_url=<encoded>
```

**回應：**

```json
{
  "ok": true,
  "exists": true,
  "pipeline_id": "P123",
  "last_contact_at": "2026-04-12T10:30:00Z",
  "status": "初面 No-show",
  "notes": "..."
}
```

或 `{ "ok": true, "exists": false }`。

dashboard 內部以 `linkedin_url`（先 canonical、後 sales URL）查 Pipeline 分頁，回最後一筆紀錄。

### 3.2 Handoff（sourcing → dashboard 送候選人）

**時機：** 使用者按「送進招募系統」按鈕、`handoffCandidate` 觸發。

```http
POST {dashboard_url}?action=addCandidate
Content-Type: application/json

{
  "pw": "<sourcing 系統服務密碼>",
  "name": "Alice Ho",
  "linkedin_url": "https://www.linkedin.com/in/...",
  "email": "",
  "source": "LinkedIn Sourcing",
  "job_ref": "JIRA690",
  "current_title": "Talent Partner",
  "current_company": "Ubiquiti Inc.",
  "score": 92,
  "notes": "10y tech recruiter, agency+in-house"
}
```

**回應：**

```json
{ "ok": true, "pipeline_id": "P456" }
```

或

```json
{ "ok": false, "error": "duplicate", "existing_pipeline_id": "P89" }
```

### dashboard 端需新增的兩支 endpoint

1. `?action=lookupCandidate` — 查詢用
2. `?action=addCandidate` — 接收 handoff

這兩支歸 recruit-dashboard 那邊開發、不在本專案，但介面契約寫死在這。

## 4. AI 評分（v1）

### 4.1 評分準則（rubric）

每個 Job 有自己的 `scoring_rubric`（純文字）。例：

```
評分原則：
- 5 年以上招募經驗 +10
- 在大廠（Google, Meta, Microsoft, AMD 等）+15
- summary 直接提到 "AI" / "automation" +15
- summary 提到 "Looking for new opportunity" +20
- 公司是傳產 / 純零售 -15
- 在職不到 6 個月 -10
- 看起來是公司 HR 帳號（不是個人）-50

備註：「AI 經驗」只看 summary 文字，不靠公司名推斷。
```

### 4.2 產生時機

- **`createJob`** 時：後端 call LLM(brief) → 產 v1 rubric
- **`refineRubric`** 時：後端 call LLM(current rubric + feedback) → 產 v(n+1) rubric
- **`updateRubric`** 時：使用者手動覆寫，version +1

### 4.3 評分時機

- **`upsertCandidates`** 時：對每筆新候選人 call LLM(rubric + candidate fields) → 回 `{ score: 0-100, reason: "..." }`
- **`rescoreAll`** 時：重新跑所有 candidates

### 4.4 LLM 設定

- 模型：Claude Haiku 4.5（成本最低、速度快）
- Temperature：0.2（評分要穩定）
- 平均一筆評分 ≈ 1.5K tokens IO，成本 < $0.0001/筆
- API key 存 Apps Script `PropertiesService`（不入 git）

### 4.5 UI 換算

`score 0–100` → 星星 `Math.round(score / 20)`，封頂 5、底 0。
顯示同時露出 `score_reason`（hover 或卡片內小字）。

## 5. 對話框（評分準則學習介面）

放在 **每個 Job 的詳細頁**。

**畫面元素：**
- 候選人卡片清單（左半邊）
- 評分準則對話區（右半邊或下半邊）：
  - 「目前評分準則」純文字框（可直接編 → call `updateRubric`）
  - 「跟 AI 說」輸入框（送出 → call `refineRubric`）
  - 「重算所有候選人」按鈕（→ call `rescoreAll`）
  - 歷史 feedback 列表（可摺疊，顯示 `created_at + feedback_text`）

**互動範例：**
- 使用者點某張候選人卡片旁的「⚠️ 不該這麼高」→ 對話框自動帶 `referenced_candidate_id` + 候選人摘要
- 使用者直接送 feedback → 後端 LLM 改 rubric → UI 提示「準則已更新 v3 → [重算所有人]?」

## 6. 開發優先序（Phase 2 MVP）

按這個順序開發、隨時可暫停 demo：

1. **Backend：建 Sheet** + 6 個分頁（含 RubricFeedback）
2. **Backend：核心 API** — `me` / `listJobs` / `createJob`（含 LLM 產 JD + rubric） / `upsertCandidates`（含 dashboard lookup + LLM 評分） / `listCandidates`
3. **Extension v0.1** — 開啟讀 active job → scan 當前頁 → POST 到 Backend
4. **UI v0.1** — 列 jobs、看 candidate 卡片（含 5 星 + dashboard 標記）、勾「shortlist」
5. **Rubric 學習** — getRubric / refineRubric / updateRubric / rescoreAll + 對話框 UI
6. **recruit-dashboard 端開發 lookupCandidate + addCandidate**（dashboard repo 那邊）
7. **Handoff 按鈕**（本系統 `handoffCandidate` 串到 dashboard）
8. **Schedule** — getActiveJob + Extension polling 排程
9. **Polish** — SourcingLog、稽核、UI 細節

## 7. 已知尚待釐清（不擋 MVP）

- LLM 呼叫量上界：5 人 × 50 候選人/天 × 評分 1 次 + refine 偶爾 ≈ 300 次/天 → 月成本仍極低（<$1）
- 排程 trigger：靠 Extension polling 還是 Apps Script time-driven trigger？目前假設 polling（Extension 開機後每 5 分鐘 GET `getActiveJob`）
- 候選人去重：同人換工作會被當不同人（`linkedin_url` 變了）→ 之後可用 `linkedin_url_canonical` 做次要 key
- Email 補強：要不要接 Apollo / Lusha 之類補 email？預設不接
- Rubric 更新後，使用者要不要看到 diff？預設只看 `rubric_after`，需要時手動翻 RubricFeedback

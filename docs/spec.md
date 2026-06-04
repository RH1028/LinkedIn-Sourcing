# LinkedIn Sourcing — Spec

> Status: 草稿，2026-06-04 起草。架構與原則已對齊，細部規格陸續補。

## 目標

把目前手動操作 LinkedIn Sales Navigator 的 sourcing 流程系統化，讓使用者：

1. 輸入職缺需求 → 系統自動產出 JD + 搜尋條件
2. 確認後讓系統「在指定時段」自動撈人選
3. 看到評分後的人選清單、勾選哪些值得聯繫
4. 親自寄 InMail（系統不代發）
5. 把確認的人選一鍵送進 recruit-dashboard 進入面試流程

## 核心約束

| 約束 | 原因 |
|---|---|
| 不做 server-side LinkedIn 自動化 | Cloudflare bot detection 會擋（已驗證 104） |
| 不代發任何 outbound 訊息 | InMail 自動化是 LinkedIn 封號最主因 |
| 每天 profile 瀏覽 ≤ 50、隨機間隔 30–120 秒 | 維持「真人獵頭」流量曲線、避開 Commercial Use Limit |
| 候選人資料只存本地 / 私有後端 | 個資與 ToS |

## 三層架構

### 1. Web UI（前端）

**職責：** 需求輸入、Filter 確認、結果展示、勾選聯繫、排程設定、狀態看板

**頁面（初步）：**
- `/jobs` — 職缺列表（這個 sourcing 在找的職缺）
- `/jobs/new` — 新增職缺：輸入需求 → 系統產 JD → 系統產 Sales Nav filter → 使用者確認
- `/jobs/:id` — 單一職缺看板：候選人卡片清單、評分、勾選「可聯繫」、狀態
- `/schedule` — 排程設定：每天執行時段、每日上限、跳過日

**技術：** 待定。預設輕量（vanilla JS + 靜態 HTML，跟 recruit-dashboard 同風格）

### 2. Chrome Extension

**職責：** 在使用者瀏覽器內執行 LinkedIn 搜尋與抓取，繞過反 bot

**行為流程：**
1. 從 Backend 拉「今天該跑的 sourcing job」
2. 在背景分頁打開 Sales Navigator
3. 依 filter 設定搜尋
4. 隨機節奏點開 profile、抓資料、回傳 Backend
5. 達到當日上限或時段結束 → 停

**權限需求：** `linkedin.com` 的 storage、tabs、scripting

**反偵測注意：** Extension 是「使用者主動安裝」的瀏覽器擴充，跟 server-side puppeteer 不同；不會留 `navigator.webdriver` 指紋；風險主要落在使用量上限

### 3. Backend API

**職責：**
- 儲存職缺、filter、候選人、評分、勾選狀態
- 排程觸發（其實是給 Extension polling 用，不需要主動 trigger）
- 提供 API 給 UI 跟 Extension
- 提供 webhook / API 把確認的人選送進 recruit-dashboard

**技術選項：**
- **Apps Script + Google Sheet**（跟 recruit-dashboard 同套，最低成本）
- Firebase / Supabase（如果預期使用者多、寫入頻率高）
- 自架 Node + SQLite（如果想要 type-safe）

**建議：** 先用 Apps Script，學到資料量真的撐不住再升級

## 資料模型（草案）

```
Job
- id, title, jd_text, description, status (active/closed)
- filter_geography, filter_title, filter_industry, filter_keywords
- created_at

Candidate
- id, job_id (FK), linkedin_url, name, current_title, current_company
- tenure, location, blurb, score, score_reason
- status (new / shortlisted / contacted / responded / rejected)
- contacted_at, response_at
- created_at, updated_at

ScheduleConfig
- user_id, daily_cap, time_window_start, time_window_end
- weekdays_only, blackout_dates
```

## 跟 recruit-dashboard 的 handoff

**方向：** sourcing → dashboard（單向）

**介面：** dashboard 後端 Apps Script 開一支 endpoint `POST /addCandidate`：

```json
{
  "name": "...",
  "linkedin_url": "...",
  "source": "LinkedIn Sourcing",
  "job_ref": "JIRA690",
  "notes": "score: 92, reason: ..."
}
```

dashboard 收到後寫入它的 pipeline 分頁，stage = "Sourcing" 或 "初篩"。

## 開發優先序

1. **MVP（先有東西能用）：** Backend 最小 schema + UI 能列出 job & candidate + Extension 能撈一個 search page 結果
2. **可用版：** 排程、評分、勾選聯繫、狀態流轉
3. **整合：** handoff 到 recruit-dashboard
4. **進階：** AI 自動產 JD、AI 評分、多帳號管理

## 待釐清

- 評分演算法的具體公式？目前是規則式（產業、年資、blurb 關鍵字）→ 要加 LLM scoring 嗎？
- 使用者超過一個的時候，Extension 怎麼識別當前使用者？OAuth？
- 排程要不要支援多職缺輪流？

# LinkedIn Sourcing

獨立的招募 sourcing 工具 — 從 LinkedIn Sales Navigator 撈候選人、評分、交給使用者決定是否聯繫。

## 跟 recruit-dashboard 的關係

**完全獨立的兩個專案，靠 API 交接。**

| | LinkedIn Sourcing（本專案） | [recruit-dashboard](https://github.com/RH1028/recruit-dashboard) |
|---|---|---|
| 職責 | Sourcing（找人） | ATS / pipeline（管人） |
| 對應產業類比 | Gem / SeekOut / hireEZ | Greenhouse / Lever |
| 操作模式 | 主動掃描、評分、勾選 | 狀態追蹤、面試流程、KR 對應 |
| 資料來源 | LinkedIn Sales Navigator | 內部 Google Sheet |
| 上下游 | **下游 → recruit-dashboard** | 接收從 sourcing 送進來的候選人 |

兩邊保持單純，sourcing 結果經由「送進招募系統」按鈕呼叫 recruit-dashboard API 寫入。

## 架構（規劃中）

```
┌──────────────────┐     ┌──────────────────────┐    ┌─────────────────┐
│   Web UI         │     │  Chrome Extension    │    │  Backend API    │
│   (需求輸入 /    │ ──► │  (在使用者瀏覽器跑    │ ──►│  (儲存結果 /    │
│    結果展示 /    │     │   實際的 LinkedIn    │    │   排程 / 串接   │
│    勾選聯繫 /    │ ◄── │   搜尋與抓取)        │ ◄──│   recruit-      │
│    排程設定)     │     │                      │    │   dashboard)    │
└──────────────────┘     └──────────────────────┘    └─────────────────┘
```

**為什麼是這個架構：**
- LinkedIn 反 bot 嚴格，**任何 server-side 自動化都會被擋**（已驗證 104 也是相同問題）
- Chrome Extension 跑在使用者真實 session，是唯一能穩定運作的路線
- Backend 只負責儲存 + 排程觸發，不直接碰 LinkedIn

## Workflow

1. **使用者輸入職缺需求** → UI
2. **產出 JD + Sales Nav filter 條件** → UI 給使用者確認
3. **排程設定**（每天何時開啟 sourcing、每天上限 30~50 人）→ Backend
4. **Extension 在指定時段啟動** → 在使用者瀏覽器跑 LinkedIn 搜尋與抓取
5. **抓取結果回傳並評分** → UI 顯示卡片清單
6. **使用者勾選「可聯繫」** → 候選人狀態改為待聯繫
7. **使用者親自寄 InMail**（系統不代發，避免 ToS 風險）
8. **送進 recruit-dashboard** → 呼叫 dashboard API 寫入 ATS

## ToS 與安全原則

- ✅ 只做 read-only sourcing，**不代發任何 outbound 訊息**（InMail / connection request 都由使用者親自操作）
- ✅ 每天 profile 瀏覽量上限 30~50（接近真人獵頭工作量）
- ✅ 隨機間隔 30~120 秒，上班時段才跑，週末停
- ✅ 候選人個資不進 git repo（見 `.gitignore`）

## 現況

- 已驗證手動 sourcing 流程可跑（55 人測試樣本，見本地 `scraped/`，未提交）
- UI / Extension / Backend 尚未開發
- 下一步：完成 `docs/spec.md` 細部規格

## 目錄結構

```
.
├── README.md
├── docs/
│   └── spec.md         ← workflow + 架構細節
├── ui/                 ← Web 前端（待建）
├── extension/          ← Chrome Extension（待建）
├── backend/            ← API（待建，可能用 Apps Script）
└── scraped/            ← 本地測試資料，不入 git
```

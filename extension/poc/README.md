# Phase 0 PoC — De-risk

最小 Chrome Extension。**唯一目的：證明 content script 可以在 Sales Navigator 搜尋頁讀到結果、且 LinkedIn 不會出警告。**

不上傳任何資料、不發任何 outbound、只 `console.log` + popup 顯示。

## 載入步驟

1. 開 `chrome://extensions/`
2. 右上角打開 **開發人員模式 / Developer mode**
3. 點 **載入未封裝項目 / Load unpacked**
4. 選資料夾：`/Users/huangwanxin/Desktop/claude/獵才/extension/poc/`
5. Extension icon 會出現在工具列（可 pin）

## 測試步驟

1. 開 https://www.linkedin.com/sales/search/people 並設一些 filter（例如 Geography=Taiwan, Title=Recruiter, Industry=Software Development）
2. **重新整理該分頁一次**（讓 content script 掛上）
3. 點 extension icon → 「Scan current page」
4. Popup 顯示 `✅ Found N`，前 5 個人選的姓名/職稱/公司
5. 開 DevTools console（⌘⌥I）看完整資料表

## 驗證標準

| 項目 | 通過條件 |
|---|---|
| Extension 可載入 | manifest 沒被拒，icon 出現 |
| Content script 跑 | 載入頁面後 console 看到 `🟢 LinkedIn Sourcing PoC content script loaded` |
| 抓得到資料 | popup 顯示 `Found N`、N ≥ 5 |
| 抓到的欄位正確 | console.table 看得到 name / title / company / url |
| **LinkedIn 不警告** | 連續操作 3–5 次（不同頁、刷新）後沒有跳「異常活動」、沒有強制登出、沒有出 CAPTCHA |

## 失敗訊號（要報回）

- 載入時 manifest 紅字錯誤
- Popup 永遠卡在 Scanning
- 抓到 0 個（DOM 結構變了）
- LinkedIn 跳警告或要求驗證
- 主畫面看起來怪怪的（被 LinkedIn 偵測干擾）

## 不在 PoC 範圍

- 翻頁、儲存資料、評分、UI、後端 — Phase 1+

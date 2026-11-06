# Studio 隔離驗收

`environment.ts` 使用真正的 Local Service、檔案交易、媒體處理、JobManager、預覽與 Vite token proxy；每個測試建立獨立暫存工作區。瀏覽器不取得程序 token，也沒有測試控制 HTTP endpoint。

Build 畫面測試以程式內 `buildExecution` 注入可成功、失敗或等待取消的 render fixture，驗證 UI 到正式 coordinator／job／artifact journal 的行為；不將這個小型 HTML fixture 當作 Astro SSG 驗收。正式 SSG 由網站／建置測試另外驗證。

`studio-authoring.spec.ts` 驗證建立、原文保存、預覽、發布、更新、撤回、刪除與垃圾桶還原。`studio-workflows.spec.ts` 驗證 412 三版本、手動合併、未保存提醒、IDE 唯讀、最新預覽及 sandbox／共用 CSS、服務中斷、taxonomy／SiteConfig 保存與引用衝突、分類遷移、實際圖片及影片處理、取消上傳同 key 重送、Poster 清除、媒體引用保護、Range、Build 成功／失敗／取消／重試，以及建立已提交但回應截斷時的同 key／原 body 復送。

相依刷新回歸核對 IDE 外部修改後切回 Studio 時，分類、Tag 與正式文章網址更新；診斷依真正 article ID／HTML 資源提供定位，不能將他篇或 metadata 錯誤定位到目前正文。重試案例以同步連按、暫停 retry-input／mutation 及截斷 202 驗證 Build／media 不重複建工作，未知結果僅沿原 key／body 重送。

`studio-command.test.ts` 另以 Chromium 載入實際 React `useCommand`，直接在同一 JS 回合呼叫 run／retry／clear，排除僅靠 disabled 按鈕剛好防重的情形。`command-harness.tsx` 僅在測試選項開啟時由 fixture 的 Vite 精確允許；沒有加入產品頁面、Local Service 控制端點或瀏覽器 token。請求仍進真正 API 與 JobManager。

公開產物案例實際 Build A／B，再由 Studio 還原 A，確認畫面使用 `/artifacts/current` 的 A proof，而歷史最新成功工作仍為 B；另以真實缺少／未追蹤／外部改動的 dist 及讀取失敗 transport 驗證畫面不誤稱同步。

執行命令：

```bash
pnpm exec vitest run --project integration tests/integration/studio-client.test.ts
pnpm exec vitest run --project integration tests/integration/studio-command.test.ts
pnpm exec vitest run --project integration tests/integration/studio-production.test.ts
pnpm exec playwright test tests/e2e/studio-authoring.spec.ts tests/e2e/studio-workflows.spec.ts
```

`studio-production.test.ts` 另以 Chromium library、離線乾淨 samplesWorkspace、真正 Studio 媒體工作及未注入 buildExecution 的 Local Service 驗證新增第六篇文章到正式 Astro Build，再撤回並重新建置；核對 HTML、RSS、搜尋、Sitemap 與列表。另以獨立案例驗證分類 `notes` → `guides` 後，管理清單仍可開啟，作者透過編輯器逐篇修正多篇舊正文連結，再以預設 Build 核對文章、分類、Tag、搜尋、Sitemap 及 RSS 新網址；RSS 以 XML parser 核對相同 article ID 的 GUID 保持 `article:<id>`。這些測試不寫共用 Playwright 報告。

Playwright 依根目錄設定執行 Chromium、Firefox、WebKit；案例透過真實服務核對來源檔與正式工作紀錄。測試所需的外部編輯、來源回應遺失或 HTTP 暫停僅在隔離工作區／Playwright transport 中施加，不新增產品的 fixture 控制參數。

所有服務、Vite、原生編碼程序及暫存工作區都在 teardown 關閉與移除。輸出、錯誤與測試報告不得包含程序 token。

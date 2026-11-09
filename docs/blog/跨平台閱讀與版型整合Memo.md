# 跨平台閱讀與版型整合 Memo

這份 Memo 說明中性版型已接入的閱讀控制，以及自訂版型時需要保留的 DOM 契約。相關瀏覽器測試不能代替真正 iPhone／iPad 的實機確認。

架構、媒體、布局、可及性、SEO 與效能目標依人與 AI Agent 共用的[網站開發與品質標準](網站開發與品質標準.md)；本文只補閱讀互動契約。修改時核對實際 DOM，不以中性版型檔名覆蓋自訂接線。

## 閱讀位置與 iOS 返回

實作位置為 `site/src/scripts/reading-history-head.ts`、`reading-history.ts`，由 `BaseLayout.astro` 接入。head 初始化必須在內容載入前同步執行，避免 Safari 原生還原和稍後的程式互相覆蓋。

- 以每筆 history entry 的獨立識別保存位置，不只以 URL 當 key；相同 URL 的再次造訪及錨點歷史仍是不同 entry。
- 離開頁面時保存離開前已追蹤的位置，避免 pagehide／轉場當下讀到已歸零的位置。
- 返回後等待頁面及非同步內容就緒，再於有限期限內校正；使用者開始 touch、pointer、wheel 或鍵盤操作後立即停止校正。
- sessionStorage／history state 不可用時，保留可閱讀的原生退回行為，不讓讀取錯誤中止頁面。
- 搜尋頁需保留 `data-search-state` 的載入／成功狀態。自訂 modal 若鎖定頁面捲動，需依閱讀控制中的通用 modal 標記協調，關閉後再恢復位置追蹤。

自訂版型新增延遲區塊、圖片或搜尋殼層時，需重新測試「先前無錨點／有錨點、相同 URL 不同 entry、返回後延遲內容、使用者立即開始捲動」；不能只測一般桌機 Back。

## 程式碼與頁面捲動

中性共用 CSS 對瀏覽器文字自動調整使用 `text-size-adjust: 100%` 與 `-webkit-text-size-adjust: 100%`，避免手機只放大部分 code block；viewport 保留使用者手動縮放。

程式碼區塊使用水平捲動，垂直捲動到邊界時仍可繼續捲動外層頁面。請保留水平與垂直不同的 overscroll 設定，不要對兩個方向一起使用 `contain`。

文章控制由 `site/src/scripts/article-enhancements.ts` 選取 `[data-article-body]` 接入，`.article-body` 負責共用正文樣式；中性 `ArticlePage` 已輸出兩者。沿用既有增強程式的自訂版型需保留對應標記，不能只保留 class 而省略 data 標記。修改 code toolbar 或表格 wrapper 時，保留預先規劃的幾何空間，避免初次載入突然推動文章。

## 目錄與定位

目錄 HTML 由 `TableOfContents` 在建置時輸出，正文不必等瀏覽器 JavaScript 才具備章節入口。停用 JavaScript 仍應可閱讀、點擊連結。

中性目錄控制由 `site/src/scripts/reading-controller.ts` 管理。被動追蹤章節只更新目前項目，不捲動整個頁面；開啟目錄時才定位一次清單。使用者開始操作目錄後，不再持續替清單捲動。

更換目錄 DOM 時，需同步維護 controller 的選取標記，以及對應的 SSR、無 JavaScript、首屏幾何、鍵盤、touch、被動追蹤與清單捲動測試。

## 自訂後的檢查

按[網站開發與品質標準](網站開發與品質標準.md#依修改範圍選擇檢查)選擇代表頁與量測範圍；以下命令檢查閱讀控制，結果與手動效能量測分開記錄。

先執行 `pnpm build`，再於獨立測試環境執行：

```bash
pnpm exec playwright test tests/e2e/reading-history.spec.ts tests/e2e/toc.spec.ts tests/e2e/public-search.spec.ts
```

閱讀控制若改變，還需要以實機測試側滑返回、旋轉、瀏覽器工具列收合、觸控捲動、同頁錨點與非同步內容。未執行的平台不能宣稱已驗證。

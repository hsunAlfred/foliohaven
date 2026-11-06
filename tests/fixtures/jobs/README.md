# Job persistence fixtures

對應 JOB-01 與 BUILD-03 的工作協調層。測試以系統暫存目錄、真實 JobManager／OperationStore／ArtifactStore、kernel flock 及獨立程序驗證；不使用正式來源或 dist 作可寫測試資料。

worker.mts 固定提供 claim 後中止、持鎖執行真正 Node 子程序、真實 artifact 提交後中止，以及 ContentService 真正完成分類遷移後中止。父測試驗證跨程序取消、native close、單 build、owner 存活／死亡、committed proof 與 queued 原始回應；分類遷移另驗同一來源 journal 的 job completion 證據、晚到取消及歷史備份還原後的證據保存。少量 media handler 只在測試內註冊，用來核對型別與排程契約，不代表媒體轉檔業務驗收。

產品沒有測試 mode、任意 worker 路徑、任意命令或 fixture 選項。完整網站 build 驗收由正式建置協調器與 site-render／build-coordinator 的 React／Astro worker 整合測試負責，這組不把小型 ArtifactStore HTML 當完整 SSG。

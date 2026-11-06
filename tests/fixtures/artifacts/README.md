# Artifact 交易隔離 fixture

`worker.mts` 只供 `tests/integration/artifacts.test.ts` 啟動真實子程序，於明確交易階段結束程序，或持有預覽 descriptor 供跨程序互斥測試。所有資料位於系統暫存目錄，由測試結束時清理。

此 fixture 沒有 Astro、實際網站內容或公開部署能力。產品程式不讀取 fixture、測試環境變數或故障參數；測試通過僅證明產物交易及復原協調。

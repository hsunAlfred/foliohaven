# 固定範例測試資料與驗收

`reference/` 保存固定測試用的五篇文章、網站設定、分類、Tag，以及兩份原始合成媒體與 metadata。
這是獨立測試資料，不從目前的 `content/` 或 `media/source/` 同步，也不要求作者保留原本的文章、標題、slug、數量或網站設定。
五篇分布與媒體的預期由這組 reference 及 `samples.test.ts` 定義；作者可以正常新增第六篇、改寫說明文章或替換成自己的 Blog。

`samplesWorkspace()` 以穩定工作副本為基底，覆蓋當前真正程式、精確 manifests 與 lockfile，再以 `reference/` 取代沙箱中的 Content 與媒體來源，離線安裝依賴。
內部 `sourceRoot` 參數僅用於測試隔離與回歸，不是正式 CLI 的來源設定。測試以六篇與替換後兩篇的作者副本驗證：固定資料仍相同，作者資料保持原樣。
Schema 或程式介面正式變更時，應同步維護這組 fixture；單純編輯文章與網站資料不需要修改測試。

在專案根目錄執行完整驗收：

```bash
pnpm exec vitest run --project integration tests/integration/samples.test.ts
```

沙箱內直接執行唯一正式 `pnpm build`，經真正 MediaService、renderer 與 ArtifactStore，驗證五篇文章、分類與 Tag 分頁、首頁、RSS、搜尋、Sitemap、媒體及更新流程，再驗證新增第六篇與獨立頁。
第六篇及獨立頁只存在測試沙箱，結束後清理；測試不改 live Content、媒體或 `dist/`，也不重用 live `node_modules`。

## 合成素材的重製工具

此為重新製作隨附範例素材的維護工具，不是日常文章管理指令。需要時在已備妥固定依賴、Sharp 與 FFmpeg 的原生環境或 Docker 容器中，從專案根目錄執行：

```bash
node tests/fixtures/samples/generate-media.mjs
```

這個指令會明確覆寫以下兩個 **live 原始素材**，保留各自的 `meta.json`；它不是測試前置步驟，不會更新 `reference/`：

- `media/source/d65927b5-381f-4d2e-90d8-f6a8c5e38e57/original.png`：Sharp 由 RGB 像素建立 1440×900 的幾何色塊，沒有外部圖片、個人資料或來源 metadata。
- `media/source/68789bc2-e491-4dbe-81de-f1a42adb7234/original.mp4`：FFmpeg `testsrc2` 建立 640×360、24 fps、2 秒、無聲的 H.264 測試影片，移除來源 metadata。

產生器只重製原檔。受管 WebP、WebM 與 poster 必須經正式 MediaService 處理，不能直接從這裡複製到 `dist/`。
影片 metadata 明確指定在 0.5 秒擷取 poster；尺寸、片長與 hash 仍由服務實際量測。
以固定工具鏈重製；若變更 Sharp、FFmpeg 或來源參數，原始 bytes 及後續處理版本可能改變，應重新建置並檢查圖片與影片輸出。
若刻意調整固定測試素材，應將審查後的原始 bytes 與對應 metadata 一起更新至 `reference/media/source/`，並重跑上述正式流程測試。

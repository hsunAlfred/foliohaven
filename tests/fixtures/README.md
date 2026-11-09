# 隔離測試資料與責任清單

本清單列出驗收 ID、測試責任與資料邊界。具體契約以[主架構規格](<../../docs/blog/全靜態部落格系統 — 需求與技術架構規格 v1.0.md>)為準；工作流程另見[新增文章流程](../../docs/blog/新增文章流程.md)及[一般獨立頁面建立流程](../../docs/blog/一般獨立頁面建立流程.md)。

各 ID 對照可執行測試及其責任邊界，方便修改程式時選擇需要的檢查。此文件不是執行結果；只有實際執行的測試及人工操作能證明對應行為通過，不能以檔案存在或局部通過代替完整驗證。

## 隔離與建立方式

- 可追蹤的小型原始素材及建立素材的程式置於本目錄，按下表責任分組；只在實際有素材時建立分組目錄。不得放入真實認證、個人資料或舊對話內容。
- 純函式測試使用每個案例自有的物件，驗證呼叫前後輸入未變更；會修改資料的測試須建立獨立沙箱，不能直接使用正式來源作可寫 fixture。
- 整合測試及工作流程測試透過測試 helper 在系統暫存目錄建立獨立 repository。每個案例取得明確的 `repositoryRoot`（沙箱根目錄）、輸出位置及清理函式，由內部函式參數或測試啟動 options 傳入。**正式 CLI、`pnpm build` 及產品 HTTP API 不提供以環境變數、請求欄位或任意路徑切換至 fixture 的入口。**
- 沙箱具有自己的 `content/`、`media/source/`、`.foliohaven/`、`dist/`、交易與工作紀錄。建立交易及 dist 切換資料時使用同一沙箱檔案系統，以實際 rename／fsync／復原行為驗收，不以記憶體模擬代替。
- 涉及程式的 snapshot／SSG／固定頁測試複製必要來源、設定、manifests 及 lockfile；不複製 live `node_modules` 或建立指回 live Workspace 的連結。需要依賴時，以同一 lockfile 及已暖 pnpm store 在沙箱內離線建立自己的 Workspace links；缺少 cache 就明確失敗。
- 本機服務與瀏覽器測試由測試協調器啟動專屬程序，以 port=0 由系統指派閒置埠及記憶體 proxy token。正式 dev 協調器的測試則使用真正 4321／5173／3001，啟動前確認空閒、結束後確認釋放。不能沿用不明既有服務；port 衝突須失敗。程序、編碼器、計時器及連線均由建立者在結束時回收。
- 故障注入僅由測試內部的 I/O、時鐘、程序及階段 hook 提供；仍要核對實際檔案、journal、子程序與回應副作用。測試用 worker 只存在測試來源，不成為產品可選的假成功 worker。
- 正常完成後清除自建暫存資料；失敗時將必要的安全診斷保存為測試報告，再回收測試自有資源。報告不得包含正文、認證、完整 headers／env 或絕對私有路徑。產品正式的未解復原資料不由測試清理。
- 每個可寫案例於執行前後核對正式來源未變更。正式五篇範例、分類、Tag、媒體及根 `dist/` 不作為沙箱的寫入目的地；測試資料不得加入正式 Content Loader 的公開集合。

固定範例來源位於 [samples/reference](samples/reference/)，由 [samplesWorkspace](samples/workspace.ts) 建立隔離副本；不跟隨作者目前的文章、站名或分類變動。根公開網站的瀏覽器驗收則使用實際來源與 Core 模型形成預期值。固定範例與根公開網站的測試責任分開，新增文章不需要維持五篇或修改驗收斷言。

## 私有目錄與識別相容測試

一般沙箱使用 `.foliohaven/`。相容案例明確建立 `.alfred/` 舊根或新舊雙根：舊根單獨存在時沿用，雙根時只讀寫新根，並核對舊內容未變；兩者皆無時建立新根，無效的新根不回退。相關測試見 [workspace-paths.test.ts](../unit/workspace-paths.test.ts) 與 [workspace-directory-compat.test.ts](../integration/workspace-directory-compat.test.ts)。不要將舊版升級 fixture 的舊名稱整批替換，否則會失去兼容驗證。

HTTP fixture 預設發送 `x-foliohaven-*`；需要舊請求時以 `legacyHeaders: true` 明確建立。協定測試另驗新舊一致、衝突及重複 headers；Cloudflare fixture 保留原始舊標記與 metadata，以核對新版能查詢及還原舊證據。這些 fixture 不含真實認證，不連正式雲端寫入。

## Fixture 分組與驗收責任

下表每個驗收 ID 只有一個主要責任組；跨模組測試可共用素材，但仍須逐一記錄各 ID 的結果，不能以單一 smoke test 取代完整案例。

| 責任組                             | 驗收 ID                                      | 主要驗證層                                |
| ---------------------------------- | -------------------------------------------- | ----------------------------------------- |
| `content-valid`／`content-invalid` | MODEL-01、LOAD-01、ROUTE-01、HTML-01         | Core 純函式、Node Loader、路由 adapter    |
| `taxonomy`                         | TAX-01、TAX-02                               | Core 聚合、交易、API、Studio              |
| `transactions`                     | SAVE-01、SAVE-02                             | 檔案交易與復原、API、衝突介面             |
| `media`                            | MEDIA-01、MEDIA-02                           | Sharp／FFmpeg 真實輸出、媒體 API          |
| `draft-private`                    | DRAFT-01                                     | Loader、預覽、媒體閉包、完整產物掃描      |
| `build`／`jobs`                    | BUILD-01、BUILD-02、BUILD-03、JOB-01         | 工作管理、snapshot、真實 SSG、dist 切換   |
| `api`                              | API-01、API-02                               | 每個 HTTP 資源與安全邊界                  |
| `public-site`                      | UI-01、SEO-01、RSS-01、SEARCH-01、SAMPLE-01  | React 靜態輸出、Head／XML／JSON、三瀏覽器 |
| `workflows`                        | STUDIO-01、FLOW-ARTICLE、FLOW-PAGE           | 真實 Studio、文章流程、獨立頁流程         |
| `engineering`                      | ENV-01、DEV-01、OUTPUT-01、DOCKER-01、DOC-01 | 安裝、工具鏈、啟停、Docker、操作文件      |

### Content：模型、載入、路由與 HTML

- 有效素材：空文章集合、完整 Published、可保存但未完成的 Draft、零 Tag、含 offset 的真實日期、同 slug 不同分類、Unicode Heading ID、無 Heading 正文、合法省略結束標籤及 SVG／MathML self-closing。
- 錯誤素材：缺 meta／HTML、壞 JSON、缺少或未知 status、未知欄位、錯誤型別、非空非法日期、超出各自 byte 上限、純數字或非法 slug、父分類缺失、完整 URL／保留根路徑／檔案與目錄碰撞、Document 或正文 H1、Heading 缺 ID／重複 ID、非法相對連結與失效 fragment。
- 核對結果：Draft 與 Published 採不同語意要求；壞來源不被吞成空站或草稿。TOC、行列診斷、站內路由與 fragment 驗證正確；讀取與 Build 不改日期或來源。純入口實際 browser build 不含 Node／native 相依。

### Taxonomy：分類、Tag 與遷移

- 有效素材：notes 3 篇、tools 2 篇與跨分類 example Tag 4 篇的正式分布副本；另建立父分類直接 1 篇、子分類 4 篇的隔離資料，以及零 Tag、空分類／Tag、相同發布時間與穩定 articleId 次排序。
- 錯誤／故障素材：以 `notes-other` 驗證 `/` 邊界；重複定義、缺父分類、有文章／子分類／導覽引用時刪除、遷移目標衝突、dry-run 過期、提交前任一 revision 改變，以及批次安裝中斷。
- 核對結果：每頁 2 篇時，同層 notes 2 頁、tools 1 頁、共同 Tag 2 頁；隔離父分類 3 頁、子分類 2 頁。集合不重複、不跨同層混入；遷移影響計畫、URL、引用更新及交易成功／拒絕一致，不留下半套定義與文章。

### Transactions：保存、衝突與復原

- 有效素材：實際兩檔 Article、taxonomy、site 設定、Studio／IDE 模式、原始載入／目前磁碟／未保存三個文字版本，以及刪除後可還原的 trash。
- 錯誤／故障素材：只改 bytes 但語意相同、缺少／過期／萬用 `If-Match`、同時保存、IDE 外部修改、prepared／backup／journal／逐項安裝／committed 各階段中止、disk／權限／rename 錯誤、未知第三版本及同名新資料阻擋還原。
- 核對結果：428／412／409 與 ETag 正確；完整提交前不回成功，受協調讀取不見兩檔半套。重啟可恢復已知版本，未知版本全部保留並阻擋一般寫入／Build；復原操作附完整最新 revisions。備份至少 7 天且最近 20 筆、trash 30 天及 purge 條件使用可控時鐘驗證，不能真的等待保留期。

### Media：真實圖片、影片與上傳故障

- 有效素材：本機合成可解碼的不同尺寸圖片、透明圖、含方向資訊的圖片、短影片、可選音軌及 poster。固定參數產生小型原始素材，不提交巨型輸出或敏感來源。
- 錯誤／故障素材：副檔名或宣告 MIME 與內容不符、不支援的動畫／不安全 SVG／HEIC、圖片像素／單邊／bytes 超限、影片 fps／尺寸／片長／bytes 超限、壞 codec／無影像軌、無效 poster 時間、損壞 cache、multipart truncated／partsLimit／client abort、轉檔 timeout／取消。
- 核對結果：真實執行 Sharp 與 FFmpeg，並以 Sharp／ffprobe 解碼輸出，驗證 WebP 尺寸、透明／方向、VP9／Opus、fps、SAR、poster、hash 與 manifest。API 輸出受控變體並支援 Range 206／416；失敗不註冊假來源、不留下可用半檔，子程序須結束。

### Draft Privacy：草稿及專用媒體隔離

- 有效素材：隔離草稿使用每次案例唯一的 sentinel（可識別測試文字），並引用只屬該草稿的圖片或影片；另有 Published 與 Draft 共用的媒體。
- 錯誤／邊界素材：未完成正文、Heading 或媒體引用的合法 Draft、損壞 meta／未知 status、首頁精選誤指向 Draft。
- 核對結果：本機可預覽 Draft；正式全部 HTML、列表、RSS、Sitemap、搜尋索引及媒體均無草稿 URL／sentinel／draft-only 資源。共用資源仍可公開；壞 meta 不因聲稱草稿而被略過。

### Build／Jobs：快照、一致性與輸出復原

- 有效素材：完整小型沙箱及上次成功的 dist，來源清單包含 Content、媒體、程式、設定、manifests 與 lockfile；同一輸入建置兩次比較穩定輸出。
- 錯誤／故障素材：建置中改／增／刪來源或程式、受協調變更後恢復原值、外部可偵測的變更、離線依賴 cache 缺失、轉檔失敗、雙 build、queue 滿、各階段取消／timeout、兩次 dist rename 間中止、還原失敗、提交後 log 失敗、相同 key 同／異 payload 及重啟。
- 核對結果：snapshot 使用自己的依賴與 Workspace links；沒有混讀 live 來源。版本變更拒絕提交並保留舊 dist digest；generation 與外部寫入的證據邊界依架構規格驗證，不能聲稱 hash 可證明所有瞬間改回。已提交產物不因後續 log 故障消失；未知復原狀態保存 backup／candidate。running 重啟標 interrupted，不冒充成功。
- 測試內部 worker 只驗證協調與故障介面；完整網站另由真正 React／Astro worker 整合測試驗證，不能把小型 fixture 輸出當成整站 Build 通過。

### API：資源契約與本機安全邊界

- 有效素材：逐一列舉主架構規格所有 route／method，使用真實沙箱文章、設定、分類／Tag、預覽、媒體、job、operation 及 recovery；讀寫須核對回應與真正檔案／工作副作用。
- 錯誤／故障素材：每個必要 precondition、非法 body／query、超限／timeout、不支援 method／Content-Type、偽造 Host／Origin／proxy token、encoded traversal、反斜線／NUL、symlink、未知 ID／檔案變體，以及請求中斷。
- 核對結果：status、Allow／ETag／Location／X-Request-Id／Cache-Control 與統一 error schema 正確；沒有任意檔案／命令入口。錯誤、log 及下載不洩漏來源原文、stack、秘密或絕對私有路徑；預覽隔離禁止 script／事件執行且不改寫保存原文。

### Public Site：UI、SEO、RSS、搜尋及五篇範例

- 有效素材：五篇正式範例的隔離副本、完整固定／文章／分類／Tag 路由、真實處理媒體、共同 ArticlePage／CSS、空集合、noindex Published、GSC 有／無、slug／分類改名，以及中文／Unicode／大小寫／多詞搜尋。
- 錯誤／故障素材：無 JavaScript、手機與桌面、鍵盤導航、缺媒體／斷連結、搜尋 q 超長、page 非法／超界／重複、索引 404／壞 JSON／未知 version、history 前後移動。
- 核對結果：一般頁及所有靜態分頁有完整初始 HTML／TOC／正常 anchor；搜尋頁只有預設第一頁的無 JS fallback。Head／canonical／JSON-LD／RSS discovery 完整，noindex 仍公開、RSS／搜尋保留；Sitemap 排除草稿、noindex、404 與 query 變體；公開文章集合為空的單一分類／Tag 頁強制 noindex，不能將這條規則擴大成所有空列表都不索引。RSS 每篇只有一個穩定非 URL GUID，日期與排序不注入 Build 時間；搜尋正規化、多詞 OR、分類／Tag 組合條件、hydration 初始一致及 URL 還原符合契約。
- 正式五篇驗證首頁兩個分類入口、notes 3／tools 2、example Tag 4、每頁 2、至少兩篇同發布時間及第四篇 noindex；共五篇文章 HTML、RSS／索引五筆、Sitemap 四個文章 URL。此組可只讀檢查正式 Build 產物；需修改的情境使用副本。

### Workflows：Studio、文章與獨立頁面

- 有效素材：沙箱中透過真實 Studio 建立／編輯／保存／預覽／發布／更新／撤回／刪除／還原文章，管理完整 metadata／SEO、taxonomy、site、媒體及 Build；另直接以 HTML＋JSON 建立文章。
- 獨立頁素材：僅在沙箱新增 React Page、Astro Entry 與固定頁登錄，使用共用 Layout／Core／SEO，驗證 Dev 預覽與完整 SSG，不增加基礎能力。
- 錯誤／故障素材：未保存離開、412 三版本、IDE 模式、發布驗證失敗、預覽請求競態、taxonomy 引用衝突／改名、服務停止、媒體／Build 取消／錯誤，以及固定頁路由衝突。
- 核對結果：操作連到真實 API 與副作用；失敗保留編輯緩衝，不以舊磁碟版本發布未保存內容。新增／更新／撤回文章會同步所有關聯產物；新增第六篇與其他流程資料只存在沙箱，不污染正式五篇。

### Engineering：工具、開發、Docker 與文件

- 有效資料：選版當日官方版本／engine／peer／平台依據、精確 manifests／lockfile／image digest、乾淨 exports、暖 store，以及完整 dist 的檔案／bundle 清單。
- 錯誤／故障素材：缺套件／工具／browser、缺編譯 exports、port 衝突、任一服務異常退出、Ctrl-C／SIGTERM、沒有成功 dist、未解 Build journal、靜態 404／MIME／Range 及管理程式／原始 metadata 洩漏掃描。
- 核對結果：五個 package 可識別；frozen 重複安裝不改 lockfile；非 root 可讀寫，原生轉檔及三瀏覽器真正可執行。初次 dev 先建置再 watch，Core／UI／CSS／HTML／JSON 更新可見，退出無遺留程序。只取 dist 即可提供完整網站，沒有 Studio／API／來源／source maps。
- Docker 在具有 Docker 的主機上，以獨立副本驗證 build、Compose config、服務啟停、資料保存及 dist-export；不停止正在使用的工作階段。選用 Dev Container 時另檢查編輯器連線與轉送。
- 依 README 的原生／Docker 入口及頁面／文章流程實際操作，確認文件與實作一致；自動測試不取代人工可用性檢查，不擴大宣稱未實測平台。

## 執行證據

新增每一組 fixture／測試時，同步寫明實際來源、產生方式、預期結果及對應驗收 ID；失敗素材不能被加入正式內容或作為成功產物。機械檢查本清單的 UTF-8、連結與 ID 完整性，只代表清單有效，不代表以上功能已實作或驗收通過。

排查失敗時保留實際命令、執行環境與版本、錯誤及安全報告位置，區分通過、失敗與未執行範圍。報告不包含認證、作者原文或私有環境資料。

## 實際測試入口

此表只對照**目前存在的檔案與可執行指令**，不表示每個入口已執行或整個 ID 已通過。實際命令、結果、環境與未執行範圍仍以當次實際執行紀錄為準；不能用測試檔存在、局部篩選通過或 fixture Build 取代完整驗收。

`tests/unit/` 使用 `pnpm exec vitest run --project unit <檔案>`；`tests/integration/` 使用 `pnpm exec vitest run --project integration <檔案>`；`tests/e2e/` 使用 `pnpm exec playwright test <檔案>`，依根設定執行三瀏覽器。以下鏈結皆相對於本檔案。

單獨執行 E2E 前，先成功執行正式 `pnpm build`，讓根 `dist/` 與受測來源一致；完整 `pnpm verify` 已包含這個順序。服務、固定埠及隔離條件依 [README](../../README.md#修改後如何檢查)準備，不能在活動作者環境內直接啟動完整驗證。

| 驗收 ID      | 主要測試檔／操作入口                                                                                                                                                                                                                                                                                                                                                               | 核對界線                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| ENV-01       | [環境檢查](../../scripts/setup.mjs)、[check-compiler.mjs](../../scripts/check-compiler.mjs)、[check-dependencies.mjs](../../scripts/check-dependencies.mjs)、[snapshot-dependencies.test.ts](../integration/snapshot-dependencies.test.ts)                                                                      | 固定版本、frozen 安裝、非 root、真實媒體工具與三瀏覽器啟停；Docker image 另以主機實際驗證                                    |
| MODEL-01     | [core-schemas.test.ts](../unit/core-schemas.test.ts)、[core-loader.test.ts](../integration/core-loader.test.ts)、[content-services.test.ts](../integration/content-services.test.ts)                                                                                                                                                                                               | Draft／Published、null／未知欄位、日期與原始來源保留                                                     |
| LOAD-01      | [core-loader.test.ts](../integration/core-loader.test.ts)、[site-render.test.ts](../integration/site-render.test.ts)                                                                                                                                                                                                                                                               | 空站、缺檔、壞 JSON、未知 status、大小與 symlink 拒絕                                                    |
| ROUTE-01     | [core-processing.test.ts](../unit/core-processing.test.ts)、[fixed-pages.test.ts](../integration/fixed-pages.test.ts)、[site-render.test.ts](../integration/site-render.test.ts)                                                                                                                                                                                                   | 路由／輸出碰撞、保留前綴、實體 Entry 與 manifest                                                         |
| TAX-01       | [core-processing.test.ts](../unit/core-processing.test.ts)、[samples.test.ts](../integration/samples.test.ts)、[ui.test.tsx](../unit/ui.test.tsx)                                                                                                                                                                                                                                  | 父子聚合、同層分類、共同 Tag、排序與分頁                                                                 |
| TAX-02       | [content-services.test.ts](../integration/content-services.test.ts)、[http-repair.test.ts](../integration/http-repair.test.ts)、[jobs.test.ts](../integration/jobs.test.ts)、[studio-workflows.spec.ts](../e2e/studio-workflows.spec.ts)、[studio-production.test.ts](../integration/studio-production.test.ts)                                                                    | 改名交易、舊正文診斷與逐篇修復、失敗無半套來源                                                           |
| HTML-01      | [core-html.test.ts](../unit/core-html.test.ts)、[core-processing.test.ts](../unit/core-processing.test.ts)、[http-diagnostics.test.ts](../integration/http-diagnostics.test.ts)                                                                                                                                                                                                    | Heading／TOC／fragment、真正資源與安全行列診斷                                                           |
| SAVE-01      | [transactions.test.ts](../integration/transactions.test.ts)、[content-services.test.ts](../integration/content-services.test.ts)、[http-etag.test.ts](../integration/http-etag.test.ts)、[studio-workflows.spec.ts](../e2e/studio-workflows.spec.ts)                                                                                                                               | CAS、strong ETag、IDE、三版本與未保存內容                                                                |
| SAVE-02      | [transactions.test.ts](../integration/transactions.test.ts)、[http-workflows.test.ts](../integration/http-workflows.test.ts)                                                                                                                                                                                                                                                       | 真 crash／故障、未知版本保留、history／trash／resolution                                                 |
| MEDIA-01     | [media-pipeline.test.ts](../integration/media-pipeline.test.ts)、[media-runtime.test.ts](../integration/media-runtime.test.ts)、[http-workflows.test.ts](../integration/http-workflows.test.ts)                                                                                                                                                                                    | 真 Sharp／FFmpeg、manifest、尺寸／方向／codec／Range                                                     |
| MEDIA-02     | [media-upload.test.ts](../integration/media-upload.test.ts)、[media-runtime.test.ts](../integration/media-runtime.test.ts)、[media-jobs.test.ts](../integration/media-jobs.test.ts)、[http-protocol.test.ts](../integration/http-protocol.test.ts)                                                                                                                                 | 偽造／超限／timeout／abort、原生程序及暫存清理                                                           |
| DRAFT-01     | [core-loader.test.ts](../integration/core-loader.test.ts)、[core-processing.test.ts](../unit/core-processing.test.ts)、[preview.test.ts](../integration/preview.test.ts)、[site-render.test.ts](../integration/site-render.test.ts)、[studio-production.test.ts](../integration/studio-production.test.ts)                                                                         | 本機可預覽、公開 HTML／feeds／索引／draft-only 媒體隔離                                                  |
| BUILD-01     | [build-inputs.test.ts](../integration/build-inputs.test.ts)、[build-coordinator.test.ts](../integration/build-coordinator.test.ts)、[snapshot-dependencies.test.ts](../integration/snapshot-dependencies.test.ts)                                                                                                                                                                  | 完整 hash／snapshot／generation、私有離線依賴及舊 dist 保護                                              |
| BUILD-02     | [artifacts.test.ts](../integration/artifacts.test.ts)、[artifacts-current.test.ts](../integration/artifacts-current.test.ts)、[build-coordinator.test.ts](../integration/build-coordinator.test.ts)、[jobs.test.ts](../integration/jobs.test.ts)                                                                                                                                   | 雙 build、取消、promotion／rollback crash 與復原                                                         |
| BUILD-03     | [site-render.test.ts](../integration/site-render.test.ts)、[build-reproducibility.test.ts](../integration/build-reproducibility.test.ts)                                                                                                                                                                                                                                           | 真正 Astro 與兩次正式 CLI：同來源、不同 job／實體快照，所有文字產物 bytes／搜尋島 UID 一致，媒體規格一致 |
| JOB-01       | [jobs.test.ts](../integration/jobs.test.ts)、[operations.test.ts](../integration/operations.test.ts)、[media-jobs.test.ts](../integration/media-jobs.test.ts)                                                                                                                                                                                                                      | 冪等、queue、跨程序 claim、重啟、完成 proof 與晚取消                                                     |
| API-01       | [http-current-artifact.test.ts](../integration/http-current-artifact.test.ts)、[http.test.ts](../integration/http.test.ts)、[http-workflows.test.ts](../integration/http-workflows.test.ts)、[http-etag.test.ts](../integration/http-etag.test.ts)、[http-diagnostics.test.ts](../integration/http-diagnostics.test.ts)、[http-repair.test.ts](../integration/http-repair.test.ts) | 真 route／method／DTO／header 與保存副作用；語意診斷不吞掉結構錯誤                                       |
| API-02       | [http.test.ts](../integration/http.test.ts)、[http-protocol.test.ts](../integration/http-protocol.test.ts)、[preview.test.ts](../integration/preview.test.ts)、[studio-proxy.test.ts](../integration/studio-proxy.test.ts)                                                                                                                                                         | token／Host／Origin、傳輸上限、fs 邊界與 iframe 隔離                                                     |
| UI-01        | [ui.test.tsx](../unit/ui.test.tsx)、[ui-browser.test.tsx](../integration/ui-browser.test.tsx)、[public-site.spec.ts](../e2e/public-site.spec.ts)、[public-site-dynamic.test.ts](../integration/public-site-dynamic.test.ts)                                                                                                                                                        | 無 JS、手機／桌面、鍵盤、共用 CSS／TOC 與分頁                                                            |
| SEO-01       | [core-processing.test.ts](../unit/core-processing.test.ts)、[site-render.test.ts](../integration/site-render.test.ts)、[samples.test.ts](../integration/samples.test.ts)、[public-site.spec.ts](../e2e/public-site.spec.ts)                                                                                                                                                        | noindex／空列表、canonical／Head／JSON-LD、GSC 有無                                                      |
| RSS-01       | [site-render.test.ts](../integration/site-render.test.ts)、[samples.test.ts](../integration/samples.test.ts)、[studio-production.test.ts](../integration/studio-production.test.ts)                                                                                                                                                                                                | XML／唯一非 URL GUID／空集合；同 ID 改 slug／分類前後亦須比較 GUID                                       |
| SEARCH-01    | [core-processing.test.ts](../unit/core-processing.test.ts)、[search-page.test.ts](../unit/search-page.test.ts)、[search-browser.test.tsx](../integration/search-browser.test.tsx)、[public-site.spec.ts](../e2e/public-site.spec.ts)、[public-site-dynamic.test.ts](../integration/public-site-dynamic.test.ts)                                                                    | q／page／history、索引失敗、hydration 與無 JS fallback                                                   |
| STUDIO-01    | [studio-command.test.ts](../integration/studio-command.test.ts)、[studio-client.test.ts](../integration/studio-client.test.ts)、[studio-authoring.spec.ts](../e2e/studio-authoring.spec.ts)、[studio-workflows.spec.ts](../e2e/studio-workflows.spec.ts)、[studio-production.test.ts](../integration/studio-production.test.ts)                                                    | 真 UI→API→來源；正式 Astro Build 與注入 render fixture 分開記錄                                          |
| SAMPLE-01    | [samples.test.ts](../integration/samples.test.ts)、[public-site.spec.ts](../e2e/public-site.spec.ts)、[public-site assertions](public-site/assertions.ts)、[固定來源](samples/README.md)                                                                                                                                                                                           | 固定五篇／兩分類／真媒體；固定測試資料獨立保存，根 dist 依目前來源驗收                                   |
| FLOW-ARTICLE | [samples.test.ts](../integration/samples.test.ts)、[studio-authoring.spec.ts](../e2e/studio-authoring.spec.ts)、[studio-production.test.ts](../integration/studio-production.test.ts)                                                                                                                                                                                              | 沙箱第六篇、更新／撤回及關聯產物，正式五篇不受污染                                                       |
| FLOW-PAGE    | [fixed-pages.test.ts](../integration/fixed-pages.test.ts)、[core-loader.test.ts](../integration/core-loader.test.ts)、[site-render.test.ts](../integration/site-render.test.ts)、[samples.test.ts](../integration/samples.test.ts)                                                                                                                                                 | React／export／Entry／registry／pageSchema；新增固定頁的 Dev 與 SSG 分別核對，不以新增文章 HMR 代替      |
| DEV-01       | [dev-supervisor.test.ts](../integration/dev-supervisor.test.ts)、[release-start.test.ts](../integration/release-start.test.ts)、[controlled-process.test.ts](../integration/controlled-process.test.ts)、[runtime-leases.test.ts](../integration/runtime-leases.test.ts)                                                                                                           | dev／release初次啟動、離線bootstrap、產物重用／修復模式、watch、port／session衝突與正常／異常程序清理    |
| OUTPUT-01    | [static-preview.test.ts](../integration/static-preview.test.ts)、[site-render.test.ts](../integration/site-render.test.ts)、[public-site.spec.ts](../e2e/public-site.spec.ts)                                                                                                                                                                                                      | 只有完整 dist，MIME／HEAD／404／Range、私有資料隔離                                                      |
| DOCKER-01    | [Dockerfile](../../Dockerfile)、[根 Compose](../../docker-compose.yml)、[選用 Dev Container](../../.devcontainer/docker-compose.yml)、[check-release-docker.sh](../../scripts/check-release-docker.sh)、[版本發行](../../docs/release/版本發行.md)                                                                                                                                            | 主機 build／config／up、重建資料保存／repair 及 dist-export；流程測試不代替主機實際驗證        |
| DOC-01       | [README](../../README.md)、[新增文章流程](../../docs/blog/新增文章流程.md)、[一般獨立頁面建立流程](../../docs/blog/一般獨立頁面建立流程.md)、[samples.test.ts](../integration/samples.test.ts)、[site-render.test.ts](../integration/site-render.test.ts)、[dev-supervisor.test.ts](../integration/dev-supervisor.test.ts)                                                         | 指令及範例與實作一致；文件 UTF-8／鏈結／Schema／編譯檢查與人工操作結果分開記錄                           |

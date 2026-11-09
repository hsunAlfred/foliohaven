# Changelog

本文件記錄各版本對使用者有影響的功能與使用要求。更新既有網站前，請先閱讀[版本更新與備份](docs/blog/版本更新與備份.md)。

`Unreleased` 收錄尚未發布的變更，發布時移至對應版本。各版本章節保留該版的功能、環境及升級說明；安裝或操作其他版本時，依所選版本的 README 與操作指南執行。

## Unreleased

## 1.1.0

2026-11-09（Asia/Taipei）

Foliohaven 1.1.0 統一系統識別、改善驗證與 Docker 工具鏈，並提供作者與 AI Agent 共用的品質及 SEO 指南。既有文章、頁面、SEO 與媒體功能延續原有契約。

### 識別命名與舊版相容

- 新專案使用 `.foliohaven/`；只有 `.alfred/` 的既有專案繼續沿用舊根，不必搬移。兩者同時存在時只使用 `.foliohaven/`，舊根不讀寫、不合併、不刪除；選定根不合法或資料損壞時報錯，不回退另一套資料。工作執行中偵測到根目錄切換會停止，保留既有紀錄。
- 呈現資料、輸出位置、快照雜湊及容器版本的環境變數改用 `FOLIOHAVEN_*`，本機服務標頭改用 `x-foliohaven-*`，保留對應舊名稱的讀取。這些環境變數的新名稱存在即優先，包含空字串；新值不合法不回退舊值。新舊標頭衝突或同名重複會拒絕，保留原驗證與來源檢查。
- Cloudflare 新操作使用 `foliohaven deploy <UUID>`／`foliohaven restore <UUID>` 及 `foliohaven-*` R2 metadata，仍辨識完整舊格式。雙組 metadata 必須完整一致，不混搭或回退掩蓋壞資料；既有物件不因改名批次重傳。舊部署紀錄、備份與指紋維持原樣，受控還原保留備份的原始 metadata。
- 編譯快取、工作紀錄、Docker 啟動與公開來源排除沿用同一套私有根選擇規則；兩種私有根及實際部署設定不進來源包或公開網站。

### 驗證與 Docker

- 新增 `pnpm verify:quick`：在隔離副本完成格式、lint、型別、完整單元、必要整合及兩個 Chromium 操作案例，供日常修改使用，不更新目前網站。quick 成功不等於完整 `pnpm verify` 或正式發行資格。
- 完整 `pnpm verify` 保留全部整合與三瀏覽器測試，先處理品質及固定埠案例，再使用獨立副本分片執行。依 CPU、Linux 實際剩餘記憶體與 cgroup 限額控制併行，預設最多兩組重工作；不把 swap 算成可用記憶體，也不以放寬 timeout 或增加重試換取通過。報告保存在選定私有根的 `reports/verification/`。
- 日常 GitHub Check 與手動完整發行驗收分開。正式發布仍要求最終公開來源、版本、檔案權限、工具鏈及同次完整驗收證據一致，不能沿用 quick、舊成功或其他來源。
- Docker 在建立相依套件及瀏覽器前對齊 UID／GID，避免晚期遞迴修改整個檔案樹的擁有者；保留非 root、離線啟動與資料保存流程。CI 重用固定的工具鏈層，不將作者私有資料或成功網站放入快取。

### 共通開發與 SEO 指南

- 新增[網站開發與品質標準](https://github.com/hsunAlfred/foliohaven/blob/v1.1.0/docs/blog/%E7%B6%B2%E7%AB%99%E9%96%8B%E7%99%BC%E8%88%87%E5%93%81%E8%B3%AA%E6%A8%99%E6%BA%96.md)，集中說明媒體載入、布局穩定、語意、可及性、閱讀互動、代表頁及交付紀錄。PageSpeed 分數為另行手動量測的開發目標，不是 Build、verify 或 CI 自動評分項目，也不代表隨附網站已達標。
- 新增[SEO 設定與繼承](https://github.com/hsunAlfred/foliohaven/blob/v1.1.0/docs/blog/SEO%E8%A8%AD%E5%AE%9A%E8%88%87%E7%B9%BC%E6%89%BF.md)，集中說明原有的逐欄繼承、摘要與描述、分享圖、覆寫與恢復操作，區分 Studio 設定提示、正式輸出及人工確認。README、AGENTS 與任務文件連到同一份指南，來源包收錄兩份完整文件。

### 升級與回復

本版沒有文章或網站設定資料模型轉換。由 1.0.0 升級時，先依[版本更新與備份](https://github.com/hsunAlfred/foliohaven/blob/v1.1.0/docs/blog/%E7%89%88%E6%9C%AC%E6%9B%B4%E6%96%B0%E8%88%87%E5%82%99%E4%BB%BD.md)保留自己的程式、文章、媒體、私有根、成功網站及部署設定，再在副本驗證。不要為了新名稱自行建立第二套私有根；若 `.env` 設有 `RELEASE_VERSION`，更新為 `1.1.0`，並依新版 Dockerfile 重建 image、保留自己的 UID／GID。

相容方向為新版讀取舊資料及識別。降版須還原配對的程式與完整備份，不能只切回舊程式或手工改寫 journal、快照及遠端歸屬標記；雲端發布與還原仍需明確操作及驗證。

### 下載與使用入口

- [foliohaven-1.1.0-source.tar.gz](https://github.com/hsunAlfred/foliohaven/releases/download/v1.1.0/foliohaven-1.1.0-source.tar.gz)
- [SHA256SUMS](https://github.com/hsunAlfred/foliohaven/releases/download/v1.1.0/SHA256SUMS)
- [README：安裝、啟動與操作](https://github.com/hsunAlfred/foliohaven/blob/v1.1.0/README.md)

下載後先校驗 SHA256 並解壓到新目錄。原生 Linux 與 Docker 維持同一套使用流程；公開網站仍只交付完整 `dist/`，不需要 Studio、管理 API、資料庫或 Node.js 服務。

## 1.0.0

Foliohaven 1.0.0 是首個正式版本，提供可直接修改原始碼的靜態網站與部落格系統。你可以自行或透過 AI Agent 製作首頁、About、FAQ 等固定頁面與共用文章版型，再用 Studio 或 IDE 管理文章、圖片、影片與網站設定。新增文章只需 HTML 正文與 JSON 資料，不必逐篇建立 React 或 Astro 元件。

本版完整收錄預覽階段已具備的系統能力。v0.x.x 定位為預覽版本，既有公開預覽版的來源與附件繼續保留；第一次使用請從本版與下列指南開始。

### 完整功能

- **固定頁面與共用版型**：React 製作主要頁面與展示元件，Astro 產生完整 HTML；可調整字型、排版、導覽、Header／Footer，文章共用一套版型。
- **Studio 與 IDE 工作流程**：管理文章、草稿、發布與更新時間、分類、Tag、精選圖片、網站設定與媒體；支援桌機／平板／手機文章預覽。也能切換 IDE 模式，由編輯器或 AI 修改來源。
- **文章與內容組織**：HTML 正文、JSON 屬性、獨立摘要、目錄、分頁、可排序的延伸閱讀，以及首頁精選文章設定；提供分類／Tag 總覽與個別頁面。
- **搜尋與 SEO**：關鍵字正規化與空格分詞、分類／Tag 組合篩選及 URL 狀態；提供逐欄 SEO 繼承、Meta／OG 分享資訊、canonical、索引設定、RSS、Sitemap 與完整網站圖示。
- **圖片與影片**：媒體庫管理、圖片尺寸選擇、替代文字、影片封面與處理流程，支援安全的 SVG／ICO、1200×630 分享圖與裁切／留白。
- **保存、預覽與建置**：來源驗證、版本、衝突與復原機制；完整建置通過內容、HTML、SEO、路由、連結與資源檢查後才更新成功網站，失敗保留上次成功產物。
- **Cloudflare 選用部署**：提供 Workers Static Assets＋R2 發布、dry-run、狀態查詢、覆寫備份、受控還原與正式網址驗證，支援大影片及 Range。
- **完整可修改來源**：隨附 Dockerfile／Compose、選用的 Dev Container、AI Agent 指引、使用文件、單元／整合／三瀏覽器測試，以及一個中性首頁與五篇教學文章。

### 下載與啟動

請下載同一版本的兩個正式附件：

- [foliohaven-1.0.0-source.tar.gz](https://github.com/hsunAlfred/foliohaven/releases/download/v1.0.0/foliohaven-1.0.0-source.tar.gz)
- [SHA256SUMS](https://github.com/hsunAlfred/foliohaven/releases/download/v1.0.0/SHA256SUMS)

完成 SHA256 校驗並解壓到新目錄，再選擇 Docker 或自行配置原生 Linux。詳細校驗與解壓步驟見[版本取得與打包指南](https://github.com/hsunAlfred/foliohaven/blob/v1.0.0/docs/release/%E7%89%88%E6%9C%AC%E7%99%BC%E8%A1%8C.md)；來源包包含完整程式、範例、文件與測試。

**Docker**：主機備妥 Docker 與 Compose，在專案根目錄執行：

```bash
docker compose up -d --build --wait --wait-timeout 600
```

首次會在本機建置 image 並準備工具與依賴；沒有預設的外部 image registry。Linux 使用者的 UID／GID 如非1000，先依 README 設定 `.env`。不需要 VS Code 或特定 AI 服務。

**原生 Linux**：使用 Node.js `26.12.1`、pnpm `12.15.0`，並依 README 準備 FFmpeg／ffprobe、編譯工具與 Playwright。原生方式與 Docker 使用同一套來源、操作及檢查；其他主機系統建議使用 Docker。

| 網址                     | 用途                         |
| ------------------------ | ---------------------------- |
| `http://localhost:5173/` | Studio：文章、媒體與網站設定 |
| `http://localhost:4321/` | 目前保存內容與程式的來源預覽 |
| `http://localhost:4322/` | 最近一次成功建立的完整網站   |

### 第一次架站的順序

1. 依 [README](https://github.com/hsunAlfred/foliohaven/blob/v1.0.0/README.md) 完成環境安裝並開啟範例。
2. 修改首頁，建立 About、FAQ 等固定頁面，再決定所有文章共用的版型與樣式。
3. 在 Studio「全站設定」填寫網站、作者、導覽、圖示及正式網站網址；範例設定可替換。
4. 使用 Studio 或 IDE／AI 新增文章、整理分類與 Tag、上傳媒體及設定 SEO。透過 IDE／AI 修改資料前先切換 IDE 模式。
5. 在4321檢查來源預覽；執行 Studio「更新網站」成功後，再到4322檢查完整產物。
6. 交付完整 `dist/` 至靜態網站服務。使用 Cloudflare 時，依部署指南填妥自己的設定、建立 R2 bucket，並完成首次網域分流；日常以 `pnpm deploy:cloudflare` 發布更新。

公開網站只需靜態檔案，不需要資料庫、Studio、管理 API 或 Node.js 服務。保存文章、更新本機網站與部署到公開網址是不同操作。

### 原始碼與 AI Agent 使用

固定頁面、文章共用版型與 Studio 未涵蓋的修改，都可以直接編輯原始碼，再重新檢查與建置。文章內容與網站設定以檔案保存，方便自行備份及版本管理。

使用 AI Agent 時，請先讓它閱讀 [AGENTS.md](https://github.com/hsunAlfred/foliohaven/blob/v1.0.0/AGENTS.md) 與 README，再描述要修改的頁面、樣式或內容。人與 AI 使用相同檔案與規則，不要求特定 AI 平台；測試與隔離 fixture 也隨來源提供。

### 使用範圍與授權

- Studio 是單人本機管理工具，同一工作區只啟動一組作者服務；公開部署僅交付 `dist/`。
- 首頁、固定頁與共用文章版型以原始碼客製；日常文章及網站設定可透過 Studio 管理。
- Cloudflare 為選用部署方式，帳號、憑證、R2 bucket 與首次網域設定由使用者準備。上傳成功後仍需核對正式網址。
- 網站圖示與 Manifest 支援不包含 Service Worker 或離線 PWA 能力。
- 自有程式、文件與示範內容採 [MIT License](https://github.com/hsunAlfred/foliohaven/blob/v1.0.0/LICENSE)；第三方資源維持各自授權。使用者自己的獨立文章與素材可自行決定授權。

### 從預覽版升級

由 0.3.1 升級至 1.0.0 時，沒有功能行為、依賴或資料格式變更。既有文章、媒體、網站設定、自訂版型及 Cloudflare 設定可沿用；請先備份完整專案，在副本整合版本差異並驗證，再採用新版。若 `.env` 有 `RELEASE_VERSION`，需改為 `1.0.0`。

從更早的預覽版升級，請同時閱讀[版本更新與備份](https://github.com/hsunAlfred/foliohaven/blob/v1.0.0/docs/blog/%E7%89%88%E6%9C%AC%E6%9B%B4%E6%96%B0%E8%88%87%E5%82%99%E4%BB%BD.md)中的歷史相容性說明，不能用新版本範例覆蓋自己的網站。

### 文件與問題回報

- [README：安裝、啟動、預覽、建置與備份](https://github.com/hsunAlfred/foliohaven/blob/v1.0.0/README.md)
- [固定頁面建立流程](https://github.com/hsunAlfred/foliohaven/blob/v1.0.0/docs/blog/%E4%B8%80%E8%88%AC%E7%8D%A8%E7%AB%8B%E9%A0%81%E9%9D%A2%E5%BB%BA%E7%AB%8B%E6%B5%81%E7%A8%8B.md)
- [共用版型與樣式調整](https://github.com/hsunAlfred/foliohaven/blob/v1.0.0/docs/blog/%E7%89%88%E5%9E%8B%E8%88%87%E6%A8%A3%E5%BC%8F%E8%AA%BF%E6%95%B4.md)
- [新增文章、SEO 與媒體管理](https://github.com/hsunAlfred/foliohaven/blob/v1.0.0/docs/blog/%E6%96%B0%E5%A2%9E%E6%96%87%E7%AB%A0%E6%B5%81%E7%A8%8B.md)
- [Cloudflare 部署](https://github.com/hsunAlfred/foliohaven/blob/v1.0.0/docs/deployment/Cloudflare%E9%83%A8%E7%BD%B2.md)
- [版本更新與備份](https://github.com/hsunAlfred/foliohaven/blob/v1.0.0/docs/blog/%E7%89%88%E6%9C%AC%E6%9B%B4%E6%96%B0%E8%88%87%E5%82%99%E4%BB%BD.md)
- [AI Agent 指引](https://github.com/hsunAlfred/foliohaven/blob/v1.0.0/AGENTS.md)
- [問題回報與貢獻方式](https://github.com/hsunAlfred/foliohaven/blob/v1.0.0/CONTRIBUTING.md)／[Foliohaven Issues](https://github.com/hsunAlfred/foliohaven/issues)

## 0.3.1

- 整理操作文件與來源包說明，更新版本取得、解壓及打包範例。
- SVG 驗證測試改用中性示例文字，保留既有 XML、格式安全與圖片輸出檢查。

## 0.3.0

- 產品正式採用 Foliohaven 名稱，根套件與 Workspace 改為 `foliohaven`／`@foliohaven/*`，Docker 與下載包識別同步調整。既有作者資料目錄與 Cloudflare 資源辨識維持相容。
- 新增獨立文章摘要與可自訂標題、文章及順序的延伸閱讀；中性首頁、文章、列表、搜尋與 RSS 實際使用對應資料。
- SEO 支援八種頁型與單筆逐欄繼承，Studio 顯示來源；分享圖可繼承、指定、不使用，文章頁型可採精選圖片。
- 新增分類及 Tag 總覽；搜尋支援正規化、空格分詞 OR 命中排序，組合分類／Tag 篩選、分頁與網址狀態。
- 支援安全的 SVG／ICO、1200×630 分享圖與裁切／留白、完整網站圖示及條件式 Manifest；不包含離線 PWA 能力。
- Studio 補強設定分區、Tag 搜尋多選與建立、輕量文章選單、預覽狀態與區網相容；優化取消過期請求、輪詢、媒體列表及重複讀取，正式 Build 保持完整檢查。
- Studio 修正預覽、圖片與列表載入時的版面跳動和點擊遺失；快速鍵盤操作時保留使用者已移動的焦點。
- 中性文章版型整合閱讀位置還原、靜態目錄及手機程式碼捲動處理，提供自訂版型整合 Memo。
- 補強 Cloudflare 搜尋驗證的定位、查詢正規化與失敗階段診斷；新增通用 Bulk Redirect 設定及驗證範例。Workers／R2 上傳、大檔、Range、狀態與還原為 0.2.0 既有能力。
- 新增獨立 Public repository 發行入口、公開來源內容檢查及手動發行流程；保留完整原始碼、測試、Docker 與五篇中性指南。

升級要求：自訂程式需更新套件引用與容器覆寫路徑。新版可讀取 0.2.0 資料；保存新欄位後不能只切回舊程式降版，必須使用升級前完整備份。詳見版本更新與備份。

## 0.2.0

- 新增原生與 Docker 共用的 Cloudflare 發布指令：重新 Build，將網頁與輔助檔上傳 Workers Static Assets、樣式與媒體上傳 R2；同名 Worker 自動建立或更新。
- 支援大檔串流與 multipart、覆寫前備份、部署紀錄、狀態查詢及受控還原；保留舊資源，不自動清空 bucket 或 CDN。
- 提供專案根目錄設定範例與完整初次網域文件，說明 Cloud Connector、Worker Routes、公開 R2 來源、快取、HTTPS 及正式網址驗證；日常 Studio／IDE 使用方式維持一致。
- 新增不讀憑證、不連遠端的部署 dry-run；Cloudflare 發布、網域驗證與本機網站更新分開操作。實際帳戶設定、憑證及生成的部署備份不進公開來源包。
- 正式網址驗證包含完整檔案校驗、SEO、索引、404 與三瀏覽器檢查；影片保留原生 HTTPS 串流及 Range，驗證播放、跳轉後續播與實際新影格。

## 0.1.0

- 提供可修改原始碼的靜態網站系統、一個首頁及五篇操作指南；可新增首頁、FAQ、About 等 React／Astro 固定頁面，文章共用一套版型。
- 文章以 HTML 正文與 JSON 屬性保存，支援草稿、發布與更新日期、分類、Tag、TOC、分頁、搜尋、RSS、Sitemap 與 SEO；新增文章不必新增程式元件。
- Studio 提供文章編輯、桌機／平板／手機預覽、全站設定、分類與 Tag、圖片與影片管理、網站更新、工作追蹤及衝突復原；也支援 IDE／AI 直接修改檔案。
- 文章預覽更新保留工作室的返回操作；離開時保護未保存內容與尚未確認的提交結果。
- 圖片及影片經受管媒體流程產生公開資源，提供圖片尺寸選擇、影片封面、Alt 及共用分享圖設定。
- 提供原生 Linux 及不依賴特定編輯器的 Docker 工作環境；均可編輯、預覽、Build 與測試。Studio 為 `5173`，來源預覽為 `4321`，成功網站預覽為 `4322`。
- 完整建置通過內容、路由、HTML、SEO、連結及資源檢查後才更新 `dist/`；失敗保留上次成功網站。公開部署只需完整 `dist/`。
- 隨附通用 `AGENTS.md`、操作文件及單元、整合、環境與三瀏覽器測試，供自行或透過 AI 修改及驗證。
- 自有程式、文件與示範內容採 MIT License；第三方資源維持原授權，使用者新增的獨立內容可自行決定授權。

使用要求：Node.js `26.12.1`、pnpm `12.15.0` 及鎖定依賴；Docker 內已提供完整工具鏈。原生環境依 README 配置 Linux、FFmpeg 與 Playwright。工作室為單人本機工具，同一工作區一次只啟動一組作者服務；作者資料、私有復原資料與自訂程式需一併備份。

# AI Agent 使用指引

本專案可以直接修改原始碼，也可以透過 Studio 管理文章與網站設定。先讀 [README](README.md)，確認使用者的目標、環境及既有修改，再依任務讀下列文件。這份指引適用於各種 AI Agent，不要求特定編輯器或 AI 服務。

## 任務入口

| 任務                                           | 先讀文件與主要修改位置                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 首頁、FAQ、About 等固定頁                      | [一般獨立頁面建立流程](docs/blog/一般獨立頁面建立流程.md)；`packages/ui/src/pages/`、公開 export、`site/src/pages/`、`site/src/fixed-pages.ts` |
| 共用文章版型、字型、排版、Header／Footer       | [版型與樣式調整](docs/blog/版型與樣式調整.md)；`packages/ui/src/article/ArticlePage.tsx`、`components/`、`styles/index.css`                    |
| 新增或管理文章、SEO、媒體、分類、Tag、網站設定 | [新增文章流程](docs/blog/新增文章流程.md)；`content/`、`media/source/`，遵守 Studio／IDE 模式                                                  |
| 系統規則、資料模型、API、建置                  | [資料與技術架構規格](<docs/blog/全靜態部落格系統 — 需求與技術架構規格 v1.0.md>)及相關程式與測試                                                |
| 更新系統版本、搬移或還原網站                   | [版本更新與備份](docs/blog/版本更新與備份.md)；先保留自訂程式與作者資料                                                                        |
| 發布到 Cloudflare、驗證正式網址或還原發布      | [Cloudflare 部署](docs/deployment/Cloudflare部署.md)；根設定、`scripts/cloudflare/` 與 `cloudflare/`，依使用者授權操作外部服務                 |

初次架站通常先完成固定頁面與文章共用版型，再設定網站資料，最後開始日常文章管理。新增文章只處理 HTML／JSON 與媒體，不逐篇建立 React 或 Astro 元件。

## 工作方式與資料保護

- 先閱讀相關規範、程式、設定及測試，以小而明確的修改完成任務；保留作者原文、自訂版型及與任務無關的變更。
- 原生與 Docker 使用同一工作流程。Docker 可用 `docker compose exec app bash` 進入；從主機執行專案命令時加 `docker compose exec app`。不要求使用 VS Code。
- 同一工作區只啟動一組作者服務。Docker app 或 `pnpm start` 已提供 Studio `5173`、來源預覽 `4321`、成功網站 `4322`；`pnpm dev` 搭配獨立 `pnpm preview` 是另一種啟動方式，不能重複占用服務。
- 透過 IDE／AI 修改內容、媒體 metadata 或網站設定前，先在 Studio「工作區」切到 IDE 模式。Studio 暫停來源保存，但讀取及預覽仍可用；完成後檢查、切回 Studio 並重新讀取。模式不能攔住外部工具，仍須避免並行寫入。
- 保存來源、文章發布狀態與成功 Build 是不同動作。依任務範圍檢查及建立網站；文章發布與公開部署遵循使用者意圖。來源預覽可協助檢查，正式結果以完整 Build 及 `4322` 為準。
- 不以範例覆蓋作者的 `content/`、`media/source/`、自訂頁面、樣式或設定；不刪除 `.alfred/` 來排除錯誤。`content/`、`media/source/`、`.alfred/`、`dist/` 與程式版本需一致備份。
- 產物提升會 rename 目錄；不把 `.alfred/` 或 `dist/` 掛成獨立 mountpoint。不直接修改根或套件的 `dist/`，修改來源並使用正式命令產生。
- Git 寫入、提交、推送、合併、tag 及部署依使用者授權執行；實作授權不自動包含外部發布。不改寫未授權的歷史，不覆蓋使用者暫存區或未提交修改。

## 架構邊界

- 沿用 Node.js、TypeScript、pnpm Workspace、React、Vite、Astro 與 Zod；不任意更換技術棧或加入非必要依賴。
- 文章正文存 HTML，屬性與網站設定存 JSON。TypeScript Core 統一管理模型、驗證、URL、分類、分頁、TOC、SEO 與搜尋；React／Astro 不重複實作規則。
- React 負責主要頁面、共用展示元件及 Studio；Astro 負責入口、HTML Document、SEO 整合與 SSG。主要內容在建置時產生完整 HTML；公開頁面預設不啟用 Hydration，搜尋依既有契約處理。
- 套件透過公開 exports 使用，不跨套件讀取 `src/`。共用 CSS 修改 `packages/ui/src/styles/index.css`，由 build／watch 同步至公開輸出。
- 草稿只供本機編輯與預覽，不進正式頁面、公開列表、RSS、Sitemap 或搜尋索引。
- `pnpm build` 是完整網站的正式建置入口；不要用裸 `astro build` 或手動複製檔案代替。失敗保留上次成功網站，不把舊產物宣稱為本次成功。
- 公開網站僅交付完整 `dist/`。Studio、Local Service、管理 API、原始文章設定、私有工作及測試資料不部署到公開網站。
- Cloudflare 發布使用 `pnpm deploy:cloudflare`：正式 Build 後固定產物，`assets/`、`media/` 上 R2，其餘交 Workers Static Assets。根 `cloudflare.config.json`、`.env.cloudflare` 為私有設定，不輸出值；`--dry-run` 不讀憑證、不連遠端。發布指令與 Studio 的本機網站更新分開，程式實作授權不自動包含外部發布。
- Cloudflare 網域、公開 R2 來源、Cloud Connector、Worker Routes 與快取由使用者依文件設定；不能自行接管或清空規則。使用者明確表示設定完成並提供 domain 後，才執行 `pnpm verify:cloudflare --domain HTTPS --deployment UUID`。上傳完成不能代替正式網域驗收。
- 雲端寫入結果未知時先用 `pnpm deploy:cloudflare:status --deployment UUID` 查證；不得刪部署 journal、盲目重送或直接強制還原。明確還原使用 `pnpm deploy:cloudflare:restore --deployment UUID`；保留 `.alfred/deployments/` 的覆寫備份，不能只回復 Worker 就宣稱 R2 與 CDN 也已回復。

## 修改後的檢查

- 固定工具版本見根 `Dockerfile`、`.node-version`、`package.json` 與 lockfile。新增工具沿用既有容器流程，並提供相應原生環境要求。
- 文章／設定修改至少執行 `pnpm validate:content`，需要更新網站時執行 `pnpm build`；React／TypeScript 修改執行 `pnpm typecheck` 及相關測試，並檢視實際頁面。
- 依範圍執行 format、lint、單元、整合及瀏覽器測試；完整門檻為 `pnpm verify`。保留測試與隔離 fixture，不刪除或放寬檢查以換取通過。
- 整合測試與完整 verify 需要空的 4321／5173／3001，執行前先保存並停止自己的作者工作階段。Docker 依 README 使用 `docker compose run --rm --no-deps app pnpm verify`，通過後再啟動 app；不在活動中的 app 內執行這兩類測試。
- 單獨執行 E2E 前先成功 Build，使根 dist 與目前來源一致；完整 verify 已包含。原生整合測試使用 Linux 預設 `/tmp`，自訂暫存環境時依 README 在該次命令恢復預設位置。
- 修改容器、依賴或啟動方式時，檢查 Docker build、Compose config、實際啟停、非 root 與資料保存；測試環境使用獨立副本，不重建或停止使用者正在操作的環境。
- 行為、設定或使用方式改變時，同步相關文件。交付時如實說明修改、實際檢查結果、未驗證範圍與已知限制，不以歷史結果代替本次驗證。

## 安全與權限

- 以非 root 帳號執行；檔案權限問題修正 UID／GID，不遞迴放寬整個專案權限。
- 本機管理服務不對公網開放；保留同源、輸入驗證、精確版本、冪等及復原守門，不新增任意命令或任意檔案讀取能力。
- 不提交或輸出 secrets、token、密碼、private key、憑證、AI 對話或其他個人敏感資料；設定示例使用安全 placeholder。
- 認證由使用者管理，不把私鑰或 AI 工具狀態複製進 repository、image、報告或公開網站。

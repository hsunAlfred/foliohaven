# Foliohaven

可直接修改原始碼的靜態網站與部落格系統。用 React 製作首頁、FAQ、About 等固定頁面，調整一套共用文章版型，再用 Studio 或 IDE 管理 HTML／JSON 文章與網站設定。也可以讓 AI Agent 依 [AGENTS.md](AGENTS.md) 協助完成這些工作；新增文章不必再寫 React 或 Astro。

專案隨附一個首頁與五篇操作指南，示範分類、Tag、搜尋、SEO、圖片及影片，並提供 Cloudflare Worker／R2 發布流程。支援獨立摘要、逐欄 SEO 繼承、延伸閱讀、分類與 Tag 組合搜尋，以及 SVG／ICO 與完整網站圖示。這些範例可以修改或移除。公開網站只交付完整 `dist/`，不需要 Studio、管理 API、資料庫或 Node.js 服務。

網站客製、內容管理、受管媒體、SEO、建置、部署與復原使用同一工作流程。人與 AI Agent 的共通開發及交付要求見[網站開發與品質標準](docs/blog/網站開發與品質標準.md)；全域／頁型／單筆 SEO 的設定與生效來源見[SEO 設定與繼承](docs/blog/SEO設定與繼承.md)。

從 [GitHub Releases](https://github.com/hsunAlfred/foliohaven/releases) 取得 `foliohaven-版本-source.tar.gz` 與 `SHA256SUMS`，或選擇對應的版本 tag。公開 repository 的 `main` 提供最新公開來源，根目錄可直接依本文件操作。下載包包含原始碼、測試、範例、使用文件及 Docker 建置設定，解壓與校驗方式見[版本發行](docs/release/版本發行.md)。

## 第一次使用的順序

自訂頁面或版型前，先讀[網站開發與品質標準](docs/blog/網站開發與品質標準.md)。效能、SEO、無障礙與閱讀要求集中維護，直接開發與 Agent 協作使用同一份基準。

1. 依下方說明選擇 **Docker** 或 **自行配置原生環境**；兩種方式都能修改程式、使用 Studio、預覽、建置及執行測試。
2. 先調整首頁，依[一般獨立頁面建立流程](docs/blog/一般獨立頁面建立流程.md)增加 FAQ、About 等需要的固定頁面。
3. 依[版型與樣式調整](docs/blog/版型與樣式調整.md)決定共用文章版型、全站外觀及導覽，在 Studio「全站設定」填妥網站、作者資料與預定的正式網站網址。
4. 依[新增文章流程](docs/blog/新增文章流程.md)，用 Studio 或 IDE／AI 編輯文章、設定 SEO、管理圖片與影片。
5. 在 `4321` 檢查目前保存的內容；完成「更新網站」後，在 `4322` 檢查最近成功的完整網站，再交付 `dist/`。
6. 要發布到 Cloudflare 時，依[Cloudflare 部署](docs/deployment/Cloudflare部署.md)設定根目錄部署資料；首次上傳後完成網域分流，再驗證正式網址。

後續需要修改版型、固定頁面或 Studio 未提供的功能時，繼續修改原始碼、檢查並重新建置；不必更換使用方式。

## 私有資料與舊版相容

`.foliohaven/` 保存私有工作、交易、快取、部署紀錄及復原資料。本文路徑均以它為準；只有舊目錄 `.alfred/` 的專案會繼續使用舊目錄，不需要搬移。兩者同時存在時，只使用 `.foliohaven/`，舊目錄保留、不讀寫、不合併也不刪除；兩者都沒有時才建立新目錄。

選中的目錄權限錯誤、不是一般目錄或資料損壞時會報錯，不回退另一套資料。工作執行中不要建立或切換私有根；改變目錄選擇時先停止服務及工作，再依[版本更新與備份](docs/blog/版本更新與備份.md)處理。新舊目錄都不納入 Git、image、公開來源包或網站產物。

內部環境變數、Studio headers 及 Cloudflare 部署標記使用 Foliohaven 名稱，仍辨識舊名稱。一般操作不需要手動填寫這些內部值；完整相容規則見[版本更新與備份](docs/blog/版本更新與備份.md)。

## 選擇一：使用 Docker

主機需要 Docker Engine 或 Docker Desktop，以及 Docker Compose plugin；不必另外安裝 Node.js、pnpm、FFmpeg 或編輯器。以下指令在取得的專案根目錄執行。專案提供 Docker 建置檔，以下指令會在本機建立對應版本的 image，沒有預設的外部 image registry。

Linux 主機先用 `id -u`、`id -g` 查看自己的使用者與群組編號。預設皆為 `1000`；若不同，將 `.env.example` 複製為 `.env`，把 `LOCAL_UID`、`LOCAL_GID` 改成實際值。已有 `.env` 時保留其他設定。這兩個值用於對齊容器的非 root 帳號；不要以 root 或放寬整個專案權限解決寫入問題。

```bash
docker compose up -d --build --wait --wait-timeout 600
```

首次需要下載套件與三種測試瀏覽器。容器包含程式編輯、編譯、媒體處理與完整測試所需工具。啟動會準備固定相依套件、編譯程式，並在尚無網站時建立範例網站；已有完整網站時保留目前版本，重新啟動不會自動發布尚未更新的內容。

| 網址                     | 用途                                         |
| ------------------------ | -------------------------------------------- |
| `http://localhost:5173/` | Studio：文章、全站設定、媒體、網站更新與復原 |
| `http://localhost:4321/` | 目前保存內容與程式的來源預覽                 |
| `http://localhost:4322/` | 最近成功建立的網站，對應根目錄 `dist/`       |

整份專案掛載在容器內；可直接用主機編輯器修改，也可以進容器使用 `nano` 或連入容器的 IDE／AI 工具：

```bash
docker compose exec app bash
```

進入後在專案根目錄執行一般 `pnpm` 指令，修改會保存回主機專案。若從主機執行，則加上 `docker compose exec app`，例如：

```bash
docker compose exec app pnpm typecheck
docker compose exec app pnpm build
```

app 已啟動三個網址，不要再於同一工作區啟動另一組 `pnpm start`、`pnpm dev` 或 `pnpm preview`。查看狀態及啟動錯誤：

```bash
docker compose ps
docker compose logs --tail 100 app
```

連接埠只發布在主機 `127.0.0.1`；管理 API `3001` 只供容器內 Studio 代理使用。Docker 位於遠端 SSH 主機時，可在自己的電腦轉送網址：

```bash
ssh -N -L 5173:127.0.0.1:5173 -L 4321:127.0.0.1:4321 -L 4322:127.0.0.1:4322 USER@HOST
```

將 `USER@HOST` 換成自己的 SSH 主機。`.env.example` 說明可調整的 `SITE_PORT`（來源預覽）、`STUDIO_PORT`（工作室）、`PREVIEW_PORT`（網站產物預覽）與 image 設定；改過連接埠時，相應調整瀏覽器網址及轉送指令。

停止服務：

```bash
docker compose down
```

重新啟動使用原啟動指令。修改來源通常由 watch 更新；改了依賴、Docker 或工具鏈時才需要重新建置 image。版本更新前先讀[版本更新與備份](docs/blog/版本更新與備份.md)，保留自己的內容與程式修改。

## 選擇二：自行配置原生環境

目前原生工具鏈以 **Linux** 為支援基準，工具鏈基準為 Debian 13／x86_64；其他主機系統建議使用上述 Docker 方式。原生方式與 Docker 使用同一份原始碼、設定與測試。

先備妥下列工具；版本以取得版本的檔案為準，不任意更新 lockfile：

| 工具                | 要求與用途                                                |
| ------------------- | --------------------------------------------------------- |
| Node.js／pnpm       | `26.12.1`／`12.15.0`；見 `.node-version`、`package.json`  |
| FFmpeg／ffprobe     | 圖片以外的媒體處理與檢查；Debian 的 `ffmpeg` 套件包含兩者 |
| Bash、flock         | 啟動腳本與程序鎖；Debian 的 `util-linux` 提供 flock       |
| Python 3、make、g++ | 原生相依套件需要的編譯工具                                |
| Git、curl、CA 憑證  | 程式版本管理、工具取得及 HTTPS 連線                       |

在專案根目錄，以一般使用者安裝依賴與測試瀏覽器；瀏覽器的作業系統套件安裝可能要求系統管理權限：

```bash
pnpm install --frozen-lockfile --prod=false
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm run setup
pnpm build:packages
pnpm --filter @foliohaven/server build
pnpm start
```

`setup` 實際檢查工具與三瀏覽器啟停，不代替安裝。瀏覽器使用 Playwright 的原生快取，或環境中的 `PLAYWRIGHT_BROWSERS_PATH`；不必把原生主機配置成容器內的固定路徑。`pnpm start` 提供與 Docker 相同的三個 localhost 網址；以 Ctrl-C 停止整組服務。

偏好分開控制開發程序時，可用 `pnpm dev` 啟動 `4321` 與 Studio，再另開終端執行 `pnpm preview` 啟動 `4322`。同一工作區一次只啟動一組作者服務；不要與 `pnpm start` 或 Docker app 並行。

VS Code Dev Container 是選用的容器編輯環境，主機需安裝 Docker、VS Code 及 Dev Containers 擴充套件；不需另外安裝上述原生工具鏈。使用 release 隨附的 `.devcontainer/` 時，可在 VS Code 執行 **Dev Containers: Reopen in Container**；進入後使用一般 `pnpm` 指令及 Ports 面板。AI 工具由使用者自行選擇及安裝，不需要特定服務的帳號或私有 volume。

公開來源的 Docker 開發／驗證映像會從 `release/templates/devcontainer/` 還原 `.devcontainer/`。調整對外提供的開發容器設定時，請同步公開的這兩處設定，避免完整來源核對失敗；個人設定不放入公開模板。

## 發布到 Cloudflare

提供原生與 Docker 共用的發布入口：HTML、RSS、Sitemap、搜尋索引等檔案交給 Worker，`assets/` 與 `media/` 交給 R2，支援大影片。同名 Worker 不存在時建立，存在時更新；Studio「更新網站」仍只更新本機網站。

Cloudflare 設定入口位於**專案根目錄**。版本附上兩份安全範例；首次使用時，複製成右側檔名，再填入自己的資料。已有設定時保留原檔。

| 隨版本提供的範例                                                 | 自己使用的設定檔         | 填寫內容                                                                   |
| ---------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------- |
| [cloudflare.config.example.json](cloudflare.config.example.json) | `cloudflare.config.json` | Account ID、Worker 名稱及已建立的 R2 bucket 名稱；`schemaVersion` 保持 `1` |
| [.env.cloudflare.example](.env.cloudflare.example)               | `.env.cloudflare`        | Worker 部署 API Token、R2 S3 Access Key ID 與 Secret Access Key            |

Linux／容器內將兩個實際設定檔設為只允許自己的帳號讀寫：

```bash
chmod 600 cloudflare.config.json .env.cloudflare
```

兩個實際設定檔不納入 Git、Docker image 或公開來源包；發行包提供 `.example` 供每個網站自行設定。Docker 執行時從掛載的專案讀取相同根目錄檔案，不必把憑證放入 Compose 環境。請將實際設定一併保存在自己的私有備份；`.foliohaven/` 保存生成的部署紀錄與復原資料。

先檢查，再明確發布：

```bash
pnpm deploy:cloudflare --dry-run
pnpm deploy:cloudflare
```

Docker 從主機執行時，在每個命令前加上 `docker compose exec app`；先依前文啟動並完成 app 初始化。dry-run 只做本機檢查，不讀取憑證或連線 Cloudflare；真正發布會重新 Build 並上傳。

首次須由你設定 R2 公開來源網域、主站 Proxy DNS、Cloud Connector 與三條 Worker Routes。**上傳成功不等於正式網址已驗證。** 完整設定、`workersPlan` 容量選項、網址驗證、狀態查詢與還原方式見[Cloudflare 部署](docs/deployment/Cloudflare部署.md)。

## 保存、預覽與建立網站

Studio 保存文章後，`4321` 顯示目前來源；在「網站更新與工作」按「更新網站」成功後，`4322` 才會更新。也可執行：

```bash
pnpm validate:content
pnpm build
```

Docker 使用者在容器內執行，或在主機為各命令加上 `docker compose exec app`。`validate:content` 檢查內容、路由與實際媒體；`build` 建立一致快照，通過 HTML、SEO、連結及資源檢查後才替換 `dist/`。失敗保留上次成功網站。不要用裸 `astro build` 代替正式入口，也不要直接修改產物。

在全站設定填寫自己的正式網站網址。`content/site.json` 的 `siteUrl` 用於 canonical、RSS 與 Sitemap；範例 `https://example.invalid/` 需換成自己的網址，本機閱讀仍用 localhost。部署時一併交付完整 `dist/`，不公開專案來源、Studio 或 `.foliohaven/`。

## 修改後如何檢查

測試與隔離測試資料隨版本保留，方便自行或透過 AI 修改程式。依改動範圍選擇檢查；修改系統規則、保存流程或工具鏈時，執行完整 `pnpm verify`。

頁面與版型依[品質標準](docs/blog/網站開發與品質標準.md)選擇受影響代表頁，手機／桌機 Performance 以至少 95、Accessibility／Best Practices／SEO 以 100 為開發目標；預期 noindex 頁按本來的索引規則驗收。這些目標以另行 Lighthouse／PageSpeed 量測確認，下列 Build、quick、完整 verify 與發行 CI 不會自動評分。純文件修訂檢查格式與連結；日常內容、共用版型及系統改動依各自影響範圍驗證。

日常修改可先執行 `pnpm verify:quick`，檢查格式、型別、完整單元、必要整合與兩個 Chromium 操作案例；它使用隔離副本，不更新目前網站。完整 `pnpm verify` 保留全部整合與三瀏覽器測試，先完成品質與固定埠檢查，再以獨立副本平行執行，流程包含根目錄正式 Build，其成功時依原規則更新 `dist/`；整輪測試結果另行判定。兩種結果都保存在目前選定私有根的 `reports/verification/`。

完整驗證預設最多同時執行兩組重工作，依 CPU／容器限額與實際剩餘記憶體降低併行。每組保留 4 GiB，另保留 512 MiB；例如剩餘 4.6 GiB 只能執行一組，9.5 GiB 可執行兩組。`pnpm verify --concurrency 3` 是明確要求三組，資源不足會顯示目前上限並拒絕，不會偷偷降成兩組。剩餘量取 Linux `MemAvailable` 與本程序 cgroup 各有限祖先的剩餘量較小值，不把 swap 或其他容器已使用的記憶體算成可用；讀值不完整時只按已知剩餘量允許最多一組，完全未知則停止。

快檢始終只有一個 lane，不接受 `--concurrency`；品質檢查至少需要 2 GiB 加 512 MiB 保留量，單元程序仍按每個 2 GiB 的預算調整。完整流程在啟動及重工作開始前各量測一次，`reports/verification/runs/<識別碼>/summary.json` 的 `resources`、`resourceSnapshots` 與 `concurrency` 記錄名目容量、觀測剩餘量及實採工作數。量測是當下觀測，不能替整個主機預留記憶體；其他容器稍後仍可能競爭，執行前應先減少背景負載。不要與作者服務共用固定埠，也不要讓其他工具在受測期間修改來源；來源改變會使本輪結果失效。

| 指令                                      | 範圍                                        |
| ----------------------------------------- | ------------------------------------------- |
| `pnpm validate:content`／`pnpm build`     | 文章、設定、路由、媒體及完整網站輸出        |
| `pnpm typecheck`                          | Core、UI、Server、工具、Studio、Astro 型別  |
| `pnpm format:check`／`pnpm lint`          | 程式與設定格式、架構邊界                    |
| `pnpm test`                               | Schema、HTML、搜尋及共用 UI 等單元測試      |
| `pnpm test:integration`                   | 隔離檔案、HTTP、媒體、工作及建置流程        |
| `pnpm test:e2e`                           | Chromium、Firefox、WebKit 的操作流程        |
| `pnpm test:environment`／`pnpm run setup` | 真實工具相容性及三瀏覽器啟停                |
| `pnpm check:compiler`                     | 套件公開入口及編譯契約                      |
| `pnpm verify:quick`                       | 日常快速檢查與必要 Chromium 操作           |
| `pnpm verify`                             | 完整品質檢查、測試、正式 Build 與瀏覽器流程 |

測試使用隔離副本；不需要保留範例文章才能測試自己的網站。單獨執行 E2E 的瀏覽器報告位於私有 `.foliohaven/reports/playwright/`；`verify` 的分片報告位於 `.foliohaven/reports/verification/`。完整驗證需執行多組媒體與瀏覽器操作，時間依機器而異；不要同時修改受驗證的來源。

`pnpm test:integration` 及 `pnpm verify` 包含真實服務啟停測試，需先釋放 `4321`、`5173`、`3001`。原生環境先保存並以 Ctrl-C 停止自己的作者服務；測試完成後再 `pnpm start`。Docker 先保存並停止 app／repair，再使用同版本的一次性容器驗證：

```bash
docker compose stop app repair
docker compose run --rm --no-deps app pnpm verify
```

指令成功後，重新開啟作者工作階段：

```bash
docker compose up -d --wait --wait-timeout 600 app
```

單獨跑整合測試時，把 `pnpm verify` 換成 `pnpm test:integration`。一次性容器沿用相同工具與專案掛載，執行完即移除；不要在仍提供作者服務的 app 內直接跑這兩個指令。

單獨執行 `pnpm test:e2e` 前，先成功執行 `pnpm build`，讓測試檢查的 `dist/` 與目前來源一致；完整 `verify` 已包含這個順序。Linux 整合測試使用預設 `/tmp`；若原生環境自訂了暫存目錄，可用 `env -u TMPDIR -u TMP -u TEMP pnpm verify` 執行驗證，只對該命令使用預設位置。

GitHub 的一般 `Check` 為快速開發檢查；正式發行另要求公開 repository `main` 的手動 **Full Release Verification**，涵蓋完整測試、Docker、原生與不同 UID 的冷啟動驗收。它不會自動建立 tag 或發布。操作及資格說明見[版本取得與打包指南](docs/release/版本發行.md)。

只需輸出靜態網站時，也可用新的空目錄接收 Docker 建置結果：

```bash
docker build --target dist-export --output type=local,dest=/tmp/foliohaven-dist-export .
```

`dist-export` 沒有網站 server；不要直接覆蓋正在使用的 `dist/`。維護發行版本、打包及 Docker 交付檢查見[版本發行](docs/release/版本發行.md)。

## 備份與修復

停止服務後備份**完整專案**，包含自己修改的頁面與樣式、`content/`、`media/source/`、`.foliohaven/`、`dist/` 及對應版本設定。備份放在專案外的私有位置；不能只靠 `dist/` 還原可編輯的網站，也不要以新版範例整包覆蓋現有專案。具體步驟見[版本更新與備份](docs/blog/版本更新與備份.md)。

若正常啟動因來源或產物需要復原而受阻，不要清空 `.foliohaven/`。Docker 改用只開 Studio 的修復模式：

```bash
docker compose stop app
docker compose up -d --build --wait --wait-timeout 600 repair
```

在 `5173` 依診斷修正，或到「衝突與復原」比較並明確選擇版本。修復模式不開兩個網站預覽，也不自動覆蓋現有網站。完成後切回：

```bash
docker compose stop repair
docker compose up -d --wait --wait-timeout 600 app
```

原生環境先停止原程序，再執行 `pnpm start --repair`；修復後 Ctrl-C 停止，再執行 `pnpm start`。仍有錯誤時保留資料與診斷繼續排查。

## 文件與原始碼入口

讓 AI 先讀 [AGENTS.md](AGENTS.md) 及本 README，再指定要修改的頁面、樣式或文章。AI 與人使用同一套檔案、規則及檢查，不需要另一套內容格式。

| 文件                                                                            | 用途                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------- |
| [一般獨立頁面建立流程](docs/blog/一般獨立頁面建立流程.md)                       | 首頁、FAQ、About 等固定頁面的完整範例       |
| [版型與樣式調整](docs/blog/版型與樣式調整.md)                                   | 共用文章版型、全站外觀與修改位置            |
| [網站開發與品質標準](docs/blog/網站開發與品質標準.md)                           | 人與 Agent 共用的效能、SEO、無障礙與交付基準 |
| [SEO 設定與繼承](docs/blog/SEO設定與繼承.md)                                   | 全域、頁型、單筆策略、生效來源與確認流程 |
| [新增文章流程](docs/blog/新增文章流程.md)                                       | Studio／IDE 管理 HTML、Metadata、SEO 與媒體 |
| [版本更新與備份](docs/blog/版本更新與備份.md)                                   | 保留自訂程式與作者資料的更新及復原方式      |
| [Cloudflare 部署](docs/deployment/Cloudflare部署.md)                            | Workers／R2 發布、首次網域分流與失敗處理    |
| [資料與技術架構規格](<docs/blog/全靜態部落格系統 — 需求與技術架構規格 v1.0.md>) | 資料模型、路由、API、安全及建置契約         |
| [CHANGELOG](CHANGELOG.md)                                                       | 各版本的功能與使用要求                      |

| 路徑                                         | 用途                                 |
| -------------------------------------------- | ------------------------------------ |
| `packages/ui/src/pages/`                     | 首頁與其他 React 頁面                |
| `packages/ui/src/article/ArticlePage.tsx`    | 所有文章及 Studio 預覽共用的文章版型 |
| `packages/ui/src/styles/index.css`           | 公開網站與文章的共用樣式來源         |
| `site/src/fixed-pages.ts`、`site/src/pages/` | 固定頁登錄及 Astro 入口              |
| `content/`、`media/source/`                  | 文章、設定與原始媒體                 |
| `packages/core/`                             | 內容驗證、路由、SEO 等共用規則       |
| `studio/`、`server/`                         | 工作室與本機管理服務                 |
| `tests/`                                     | 單元、整合、瀏覽器測試及隔離範例資料 |
| `cloudflare/`、`scripts/cloudflare/`         | 公開部署模板與發布、狀態、還原工具   |
| `.foliohaven/`                                   | 私有工作、交易、快取及復原資料       |
| `dist/`                                      | 成功建立後可公開交付的完整網站       |

## 授權

本專案自行撰寫的程式、文件與示範內容採用 [MIT License](LICENSE)，版權宣告為 `Copyright (c) 2026 alfred`。

第三方字型、依賴套件及 Docker 內工具維持各自的授權。Studio 使用的 Noto Sans TC 字型採 SIL Open Font License 1.1，來源與隨附授權見 [SOURCE.md](studio/src/fonts/noto-sans-tc/SOURCE.md)；範例圖片、影片與重製方式見[範例素材說明](tests/fixtures/samples/README.md)。

使用者之後新增的獨立文章、圖片及其他媒體，由使用者自行決定授權；不因使用本系統而自動採用 MIT。

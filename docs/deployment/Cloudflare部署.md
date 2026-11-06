# 發布到 Cloudflare Workers 與 R2

本專案提供一個發布指令：重新建立網站，將網頁與輔助檔放到 Worker，將樣式、字型、圖片與影片放到 R2。同名 Worker 不存在時建立，已存在時更新。首次需要你在 Cloudflare 設定網域與分流；之後通常只需再次執行發布指令。

網站仍然是靜態網站。Studio、管理 API、文章原始檔、憑證及備份不會上傳。Studio「更新網站」只更新本機網站；發布到 Cloudflare 是另一個明確動作。

## 1. 準備本機工作環境與網站

先依 [README](../../README.md) 完成 Docker 或原生 Linux 環境初始化，確認 Studio `5173`、來源預覽 `4321` 與成功網站 `4322` 的使用方式。不需要另外全域安裝 Wrangler，也不需要登入 Wrangler；專案會使用鎖定的工具與你提供的憑證。

原生環境在專案根目錄執行本文的 `pnpm` 命令。Docker 先完成初始化：

```bash
docker compose up -d --build --wait --wait-timeout 600 app
```

接著進入容器，在同一個專案根目錄執行本文命令：

```bash
docker compose exec app bash
```

也可以留在主機，每個 `pnpm` 命令前加上 `docker compose exec app`。不要在 app 已啟動時再開另一組作者服務。

先完成自己的頁面、文章與版型。在 Studio「全站設定」填寫預定的正式網址，例如 `https://blog.example.com/`。透過 IDE／AI 修改 `content/site.json` 前，先在 Studio 切換到 IDE 模式。`siteUrl` 決定 canonical、OG URL、RSS 與 Sitemap；發布指令不會替你改這個值。

首次 DNS 尚未完成仍可建立及上傳網站。網址若仍是 `example.invalid`，上傳不會自動變成正式網址，最後網址驗證會指出需要修正的項目。

## 2. 建立網站專用 bucket 與憑證

本文使用以下安全例名，操作時換成自己的名稱：

| 用途            | 範例                  |
| --------------- | --------------------- |
| 網站 Worker     | `my-blog`             |
| R2 bucket       | `my-blog-assets`      |
| 讀者開啟的網站  | `blog.example.com`    |
| R2 公開來源網域 | `storage.example.com` |

1. 開通同一個 Cloudflare 帳戶的 Workers 與 R2。在 R2 建立一個僅供這個網站使用的 bucket。此工具使用**預設 jurisdiction** 的標準 S3 endpoint；不要選需要其他 endpoint 的管轄限制。一般 Automatic／Location Hint 是資料位置提示，與 jurisdiction 不同。詳見 [R2 資料位置](https://developers.cloudflare.com/r2/reference/data-location/)。
2. 在帳戶的 Workers & Pages 頁面取得 Account ID；這是帳戶識別，不是 Zone ID。可依 [Cloudflare 帳戶識別說明](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/)查找。
3. 建立 Worker 部署用的 Cloudflare API Token。它須能在指定帳戶查詢設定與版本、**建立新 Worker**、部署及管理版本；控制台權限名稱可能顯示 Workers Admin／Workers Scripts Edit。不要只限制為尚未建立的單一 Worker，也不需要 DNS、Cloud Connector、Worker Routes、快取清除或 Token 權限清單的管理權。可參考 [Workers 權限說明](https://developers.cloudflare.com/workers/authorization/workers/)。
4. 在 R2 管理 API Tokens，建立限這個 bucket 的 **Object Read & Write** 憑證，保存產生的 **Access Key ID** 與 **Secret Access Key**。這兩個 S3 欄位與上一步的 Worker API Token 不同，不互相代填。bucket 必須先存在；發布指令不會替你建立 bucket 或擴大權限。詳見 [R2 API 憑證](https://developers.cloudflare.com/r2/api/tokens/)。

一個網站使用專用 bucket，同一時間只使用一個工作副本發布。工具的本機程序鎖無法阻止其他主機、控制台或其他上傳工具同時改寫 R2。

## 3. 填寫專案根目錄設定

版本附上兩份公開範例。以下複製指令**只在實際設定檔尚未存在時執行**；已有設定請保留：

```bash
cp cloudflare.config.example.json cloudflare.config.json
cp .env.cloudflare.example .env.cloudflare
chmod 600 cloudflare.config.json .env.cloudflare
```

編輯 `cloudflare.config.json`：

```json
{
  "schemaVersion": 1,
  "accountId": "YOUR_CLOUDFLARE_ACCOUNT_ID",
  "workerName": "my-blog",
  "bucketName": "my-blog-assets"
}
```

`accountId` 換成自己的 32 字元帳戶 ID；Worker 與 bucket 名稱使用小寫英數及連字號。Worker 名稱 1–63 字元，bucket 名稱 3–63 字元，頭尾不能是連字號。使用網站專用 Worker；已有不同應用程式、綁定或多版本分流的同名 Worker 會被拒絕。

可另外加入 `"workersPlan": "paid"`，宣告帳戶實際使用付費 Workers 方案。不填時預設 `free`，本機檢查 Worker 靜態檔案最多 20,000 個；`paid` 為 100,000 個，單檔都不超過 25 MiB。這是你填寫的容量宣告，**不是自動查詢帳務或升級方案**，最終仍以 Cloudflare 帳戶實際限制為準。R2 中的檔案不計入這個 Worker 檔數。

在 `.env.cloudflare` 的三個欄位填入自己的憑證：

```dotenv
CLOUDFLARE_API_TOKEN=YOUR_WORKERS_API_TOKEN
R2_ACCESS_KEY_ID=YOUR_R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY=YOUR_R2_SECRET_ACCESS_KEY
```

保持單行值，不加入其他欄位、命令或插值。兩個實際檔案必須由執行命令的帳號擁有、權限為 0600，而且不能是符號連結。Docker 直接讀取掛載專案中的檔案，不必把憑證放到 Compose、image 或長駐服務環境。

實際設定不進 Git、Docker image 或發行來源包；請另外私下備份。不要把憑證貼進對話或檢查報告，也不要把原始 API 回應當成需要公開的錯誤資訊。

## 4. 先檢查，再上傳

本機檢查會重新執行完整 Build、固定成功產物並檢查分流及容量；不讀取憑證，也不連線或上傳 Cloudflare：

```bash
pnpm deploy:cloudflare --dry-run
```

檢查通過後，明確執行真正發布：

```bash
pnpm deploy:cloudflare
```

Docker 從主機執行的對應指令是：

```bash
docker compose exec app pnpm deploy:cloudflare --dry-run
docker compose exec app pnpm deploy:cloudflare
```

不要與另一個網站更新或發布工作同時執行。Build 失敗就不開始上傳；不會把上次成功網站當作這次發布結果。

| 本次正式網站檔案                                    | 上傳位置                                         |
| --------------------------------------------------- | ------------------------------------------------ |
| `dist/assets/**`、`dist/media/**`                   | R2，保留相對 key，例如 `media/<UUID>/video.webm` |
| 所有其他檔案，包括 HTML、`404.html`、XML、JSON、TXT | Workers Static Assets，保留原路徑                |

大影片使用串流分段上傳，不受 Worker 單檔 25 MiB 限制；仍需符合 R2 容量及本機可用記憶體、備份磁碟限制。單檔含重試的傳輸時間有上限，程序會顯示階段及進度；不要將「本機讀取 bytes」誤認為已由遠端確認。

每次命令會輸出 `deploymentId`，也就是這次部署的 UUID。請保留它；結果與復原資料在私有 `.alfred/deployments/<UUID>/`，摘要為 `receipt.json`，逐檔清單為 `manifest.json`。

**`uploadStatus: uploaded` 表示 R2 與 Worker 上傳範圍完成。** 初次網域尚未設定時，`domainVerification` 仍是 `pending`。這時不能用 `workers.dev` 宣稱全站可用，因為樣式與媒體是由下一節的自訂網域分流到 R2。

## 5. 初次設定網域、分流與快取

這一節由網站管理者在 Cloudflare 操作。發布指令不修改 DNS、公開 bucket 網域、Cloud Connector、Worker Routes、快取規則或憑證。通常只需初次設定；改網站網域、bucket 或路徑時重新核對。

### 5.1 連接 R2 公開來源網域

1. 確認 `example.com` 的 Zone 由**相同 Cloudflare 帳戶**管理。
2. 到 **R2 → 網站專用 bucket → Settings → Custom Domains → Add**，填入 `storage.example.com`，依畫面確認新增 DNS，等待狀態為 Active、HTTPS 憑證正常。
3. 用一個已上傳的公開資源測試來源，例如 `https://storage.example.com/media/<實際UUID>/image.webp`。請使用 `manifest.json` 中真正存在的 key，確認可讀取而不是 403／404。

連接公開自訂網域會讓 bucket 的物件可被讀取，因此這個 bucket 只放公開網站資源。Cloud Connector 的 R2 來源要求同 Zone 的公開自訂網域，不能用 `r2.dev` 代替。不要手動建立一筆指向 S3 API endpoint 的 CNAME 來冒充 R2 Custom Domain；連接方式見 [R2 公開 bucket](https://developers.cloudflare.com/r2/buckets/public-buckets/)與 [Cloud Connector 的 R2 要求](https://developers.cloudflare.com/rules/cloud-connector/providers/)。

### 5.2 建立主站 Proxy DNS 與三條 Worker Routes

以下為同 Zone、相同帳戶的子網域配置範例。在 **DNS → Records** 建立主站的 CNAME，目標使用上一步**已 Active 的實際 R2 來源網域**：

| Type  | Name   | Target                | Proxy status  |
| ----- | ------ | --------------------- | ------------- |
| CNAME | `blog` | `storage.example.com` | Proxied，橘雲 |

這個例子的主站請求由 Worker Routes 或 Cloud Connector 接手，不使用任意假的 origin IP。不要覆蓋仍在使用的正式網站記錄；先確認這個 hostname 可供本網站使用。DNS 必須經 Cloudflare Proxy，不能是 DNS only。

到該 Zone 的 **Workers Routes**（或對應 Worker 的 Settings → Domains & Routes）設定三條路由：

| Route                       | Worker                    |
| --------------------------- | ------------------------- |
| `blog.example.com/*`        | `my-blog`，與專案設定相同 |
| `blog.example.com/assets/*` | None／不指定 Worker       |
| `blog.example.com/media/*`  | None／不指定 Worker       |

後兩條是較精確的排除規則，讓資源繞過網站 Worker。每條結尾的 `*` 都要保留，包含帶查詢字串的請求。若 Worker 頁面無法新增 None 例外，使用 Zone 的 Workers Routes 操作；不要建立兩個空 Worker 代替 None。規則判讀見 [Workers Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)。

這裡使用的是 **Worker Route**，不要另外把 `blog.example.com` 接成接管 origin 的 Worker Custom Domain。發布工具不在 Wrangler 配置中宣告 routes，後續更新保留這組由你管理的路由。

### 5.3 設定 Cloud Connector

在主站 Zone 的 **Rules → Cloud Connector** 建立規則，Provider 選 **R2**，來源 hostname 填 `storage.example.com`。匹配條件為：

```text
http.host eq "blog.example.com" and
(
  starts_with(http.request.uri.path, "/assets/") or
  starts_with(http.request.uri.path, "/media/")
)
```

只匹配讀者使用的主站 hostname，不把相同規則套到 `storage.example.com`。URL path 原樣對應 bucket key，不加 bucket 名稱、版本目錄或 SHA 前綴，也不另外移除 `/media/`。

例如 `https://blog.example.com/media/<UUID>/video.webm` 應取得 bucket 中的 `media/<UUID>/video.webm`；首頁與 `/sitemap-index.xml` 則由網站 Worker 供應。[Cloud Connector](https://developers.cloudflare.com/rules/cloud-connector/)不會替你完成 URL rewrite 或快取設定。

### 5.4 設定快取與 HTTPS

在 **Caching → Cache Rules → Create rule** 建立或核對上述資源路徑的規則，條件沿用 5.3 的主站 hostname 與 `/assets/`、`/media/` 表達式。正式建議如下：

| 欄位 | 設定 |
| --- | --- |
| Cache eligibility | Eligible for cache |
| Edge TTL | 有來源 Cache-Control 就遵循，沒有就略過快取 |
| Browser TTL | Respect origin |
| Status Code TTL | 不另外新增 |
| Place at | 有前面的通用 TTL 規則時置於其後，避免被強制長效快取覆蓋 |

Edge TTL 對應選項為 `Use cache-control header if present, bypass cache if not`。尊重物件的 `Cache-Control`，不要用強制 Edge TTL 或 Browser TTL 長期覆蓋重新驗證。上傳器對可變 URL 使用 `public, max-age=0, must-revalidate`；同一媒體 URL 更新後，不能繼續長時間顯示舊檔。介面及規則優先順序見 [Cache Rules 設定](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/)與[規則順序](https://developers.cloudflare.com/cache/how-to/cache-rules/order/)。

HTML、XML、JSON、TXT 也不得被其他 SPA fallback、去副檔名或全站補尾斜線規則改寫。例如 `/sitemap-index.xml` 應直接回 XML，而不是轉到 `/sitemap-index.xml/` 或首頁。

在 **SSL/TLS** 確認主站與 R2 來源憑證有效，使用可驗證來源憑證的 Full (strict)，並讓 HTTP 轉向 HTTPS。以瀏覽器開啟主站，確認頁面沒有混合內容；影片可播放與拖曳，缺少的檔案應回錯誤而非 200 HTML。

已有其他轉址規則時，確認 Blog 不會被轉到別的 hostname。可在 **Rules → Overview → Create rule → Redirect Rule／Single Redirect** 新增專用規則：

| 欄位 | 設定 |
| --- | --- |
| Custom filter expression | `http.host eq "blog.example.com" and not ssl` |
| Target URL type | Dynamic |
| Target expression | `concat("https://blog.example.com", http.request.uri.path)` |
| Status code | 301 |
| Preserve query string | 勾選 |
| 順序 | 排在會匹配 Blog 的通用轉址規則之前 |

將兩處 hostname 換成自己的主站網址。保留查詢字串不是預設值；沒有勾選時，搜尋文字或分頁參數可能在轉址時消失。完成後分別測首頁、文章路徑與 `/articles/?q=test&page=2`，確認 hostname、路徑及參數都保留。參見 [Single Redirect 設定](https://developers.cloudflare.com/rules/url-forwarding/single-redirects/settings/)。

如果原本已有會快取舊內容的規則，先修正規則，再由管理者在控制台清除受影響 URL 的快取。發布工具不會代替你 purge，也不會要求把快取管理權加到日常 token。R2 直接 API 已更新，不代表 CDN 還沒到期的舊內容也已更新，詳見 [R2 一致性與快取](https://developers.cloudflare.com/r2/reference/consistency/)。

### 5.5 保持 HTML 與上傳內容一致

本專案的正式網址驗收會逐檔核對公開內容與成功部署的 SHA／大小。Cloudflare 的 Web Analytics／RUM 自動設定會額外將統計程式加入 HTML，即使頁面能開啟，也會造成內容比對失敗；不同請求標頭可能影響是否注入，不能只用一次 fetch 判定已關閉。

正式建議只對本站停用 RUM 自動注入，避免影響同 Zone 的其他網站：

1. 在主站 Zone 進入 **Rules → Overview → Create rule → Configuration Rule**。
2. 自訂條件填 `http.host eq "blog.example.com"`，換成實際主站 hostname。
3. 只新增 **Disable Real User Monitoring (RUM)** 並啟用，再 Deploy。這是開啟「停用 RUM」設定，即 `disable_rum: true`，會停止本站的 RUM 效能量測；不改 DNS、Worker Routes、Cloud Connector 或其他 hostname。
4. 以原正式網址重新驗收；不需要只為關閉注入重新上傳網站。若其他功能仍會改寫 HTML 或媒體，依失敗證據處理實際功能，不直接關閉所有安全設定或放寬檔案比對。

Configuration Rule 優先於 Web Analytics 的開啟規則。若要保留網站統計，需把所選方案納入來源與驗收契約，不能先忽略額外程式來宣稱原檔案已通過。設定依據見 [RUM 停用規則](https://developers.cloudflare.com/rules/configuration-rules/settings/#disable-real-user-monitoring-rum)及[自動注入說明](https://developers.cloudflare.com/web-analytics/get-started/#sites-proxied-through-cloudflare)。

## 6. 設定完成後驗證正式網址

確認上一節都完成後，使用自己的正式網域與**真正上傳成功那次**的 UUID 執行：

```bash
pnpm verify:cloudflare --domain https://blog.example.com --deployment <UUID>
```

`<UUID>` 是說明用代稱，執行時請換成實際值，不輸入角括號。Docker 同樣在前面加 `docker compose exec app`。

命令會檢查這次網站的公開檔案、MIME、XML 原路徑、404、SEO 與影片 Range，並以 Chromium、Firefox、WebKit 檢查頁面及影片播放、跳轉後續播；報告與截圖保存在 `.alfred/reports/cloudflare/<UUID>/`。網址須是公開 HTTPS 根網址，不能指定本機、私有網路、其他 port 或額外路徑。

報告的 `scope: automatic`、`status: passed` 與收據中的 `domainVerification` 記錄自動檢查結果；`manualVerification: pending` 表示控制台與人工項目仍需另行確認。自動命令成功不代表人工項目已完成。每次重新驗證會先標為待驗收；取消或發生錯誤會保存本次已完成的檢查，不沿用上次的通過結果。`404.html` 會透過專屬的不存在網址核對錯誤頁，不要求明確的 `/404.html` 本身也回 404。

人工核對入口為 **Domain → Rules → Rule simulator**（官方文件亦稱 Cloudflare Trace）。選擇 `GET`，逐一模擬首頁、`/sitemap-index.xml`，以及實際存在且帶 `?check=1` 的 `/assets/…`、`/media/…` 網址；在結果中選擇 **All configurations**，檢查匹配的規則及目的地。Rule simulator 評估的是模擬請求的設定，不是正式流量的歷史紀錄，操作見 [Cloudflare Trace](https://developers.cloudflare.com/rules/trace-request/how-to/)。

搭配 **Workers Routes** 與 **Cloud Connector** 頁面確認：`/assets/`、`/media/` 命中資源的 Connector 規則、目的地為 R2 公開來源，並由較精確的 None 路由繞過網站 Worker；首頁與 XML 不命中該 Connector，對應網站 Worker 的 Static Assets。Static Assets 可直接回傳檔案而不執行 Worker code，因此沒有 Worker execution 節點不能單獨判定失敗；介面沒有顯示明確節點時，以既有 Routes／Connector 設定與模擬結果一起判讀，參見 [Static Assets](https://developers.cloudflare.com/workers/static-assets/)。

再次發布前後核對三條 Routes 與 Cloud Connector 未改動。人工結果請記錄對應 deployment UUID、domain、日期、確認者及範圍，與 HTTP／瀏覽器報告分開保存；自動 CLI 的 `manualVerification: pending` 不會代替人工簽認，也不需為了勾選結果手動修改部署 journal／receipt。

若交由 AI 協助，請先明確告知「Cloudflare 設定完成」並提供正式 domain，之後才請它驗證；不需要提供 token。測試大影片時，需另外包含大於 25 MiB 的有效影片及 512 MiB 級上傳，不能只用隨附短片推定大檔通過。

## 7. 後續更新、查詢與還原

修改內容、設定、頁面或版型後，先在本機確認，再執行相同 `pnpm deploy:cloudflare`。指令重新 Build，核對同名 Worker、略過相同的 R2 內容，並發布新版本；不必每次重建網域規則。

查詢一次部署的實際遠端狀態：

```bash
pnpm deploy:cloudflare:status --deployment <UUID>
```

失敗、斷線或取消後先執行這個命令。`unknown` 表示寫入可能已送出但結果尚未確認；稍後讀到舊值或 404 也不能證明先前請求不會提交。不要立即再次上傳、還原或刪掉紀錄來略過守門。仍無法判定時，保留本次目錄，依階段與 UUID 檢查 Cloudflare 部署／R2 狀態，不貼出憑證或原始 API 回應。

需要回到本次發布前的版本時，明確執行：

```bash
pnpm deploy:cloudflare:restore --deployment <UUID>
```

還原前會完整核對備份、遠端物件與 Worker 版本，確認沒有後續部署或外部修改，再先還原本次覆寫的 R2 舊檔、後回復 Worker。原 Worker 版本必須仍在平台可回復的最近 100 個已發布版本內；缺少備份、版本失效或衝突時停止，不強蓋後來的內容。首次部署沒有舊 Worker 版本時，只能處理既有 R2 物件，不能還原成不存在的網站，也不自動刪 Worker。平台限制見 [Worker 版本回復](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)。

Worker 會以原版本建立一筆新的部署，因此部署識別碼會改變。這個動作不回寫其他 Worker 設定；工具會核對並保存還原時的設定指紋，以偵測後續修改。網域、Cloud Connector、路由與快取規則仍由你管理。

幾項使用界線：

- 覆寫前會先把本輪全部舊檔備份到 `.alfred/deployments/<UUID>/backups/r2/`。請預留足夠磁碟，不清除這些紀錄來排錯。
- R2 同一 key 的新內容一寫入，就可能被舊網站讀到。R2、Worker 與 CDN 沒有全站原子切換；Worker 發布失敗不代表線上完全沒變。
- 成功的新 key 與舊版未再引用的 key 會保留。工具不鏡像清空 bucket、不自動清 CDN，也不自動按天數刪除本機備份。
- 單次條件式 PUT 與 multipart 的並寫保護不同；不要從別台主機或控制台同時改同一 bucket。
- `restored` 代表可核對的遠端資料與版本回復，不代替正式網址、瀏覽器及 CDN 驗證；還原後再驗公開網址。

更新系統版本或搬移網站時，連同根目錄實際設定、憑證、完整 `.alfred/`、作者資料與對應程式一併私下備份。具體方式見[版本更新與備份](../blog/版本更新與備份.md)。

還原後要驗證舊網站時，請使用被回復版本原本的部署 UUID；剛執行 restore 的 UUID 記錄的是被撤銷的新版，不能用那份新版清單驗舊網站。保留歷次部署目錄，才能找到對應清單。

## 8. 舊網址與 Bulk Redirects

修改文章網址、分類或舊分頁結構後，可用 Bulk Redirects 維護明確的舊址對照。這是網域管理者的設定，不由 Foliohaven 上傳指令建立。來源 hostname 必須經 Cloudflare Proxy。

在帳戶的 **Bulk redirects**，或網域 **Rules → Settings → Bulk Redirects** 入口，先建立 **Bulk Redirect List**，匯入並檢查資料；再建立 **Bulk Redirect Rule** 選用該清單並啟用。只有清單、沒有啟用規則不會生效。這些清單與規則屬於帳戶層級，操作時確認 hostname 範圍。[官方設定步驟](https://developers.cloudflare.com/rules/url-forwarding/bulk-redirects/create-dashboard/)

### 8.1 CSV 格式

每列依序為來源網址、目標網址、狀態碼、保留查詢字串、包含子網域、匹配子路徑、保留路徑後綴。**不要加欄位標題列**。建議保存為 UTF-8 無 BOM、LF 換行，一列一筆，明確填出所有選項；網址含逗號時以雙引號包住。

以下全部是安全示例，必須換成自己的 hostname 與實際存在的目標：

```csv
blog.example.com/sitemap.xml,https://blog.example.com/sitemap-index.xml,301,TRUE,FALSE,FALSE,FALSE
blog.example.com/articles/page/2/,https://blog.example.com/articles/?page=2,301,FALSE,FALSE,FALSE,FALSE
blog.example.com/category/old-notes/,https://blog.example.com/category/notes/,301,TRUE,FALSE,FALSE,FALSE
```

來源網址不可含 query string。範例來源省略 scheme，表示同時匹配 HTTP／HTTPS；來源若明填 scheme，就只匹配該 scheme。匯入畫面逐列確認實際解析結果。[CSV 格式](https://developers.cloudflare.com/rules/url-forwarding/bulk-redirects/reference/csv-file-format/)

### 8.2 查詢字串與迴圈

`Preserve query string=TRUE` 使用原請求的 query，會取代目標 URL 自帶的 query。因此舊分頁轉到 `?page=2` 的範例使用 FALSE，避免固定頁碼被覆蓋。若需要同時保留原有搜尋條件並轉換頁碼，應另用可明確組合 query 的動態規則，不把多個來源狀態硬塞進同一靜態對照。

需要整個舊目錄搬移時，才啟用 Subpath matching，並明確決定 Preserve path suffix；不要無意套到同層或其他網站。部署前排除來源等於目標、A→B→A、目標仍命中舊址，以及 HTTP／HTTPS 規則互相轉回的情況。[參數與查詢字串行為](https://developers.cloudflare.com/rules/url-forwarding/bulk-redirects/reference/parameters/)

### 8.3 Rule Simulator 與實際驗證

在 **Domain → Rules → Rule simulator** 分別測試：

| 請求 | 預期 |
| --- | --- |
| `/sitemap.xml?check=1` | 301 到 `/sitemap-index.xml?check=1`，再取得 XML |
| `/articles/page/2/` | 301 到 `/articles/?page=2`，再顯示對應分頁 |
| `/category/old-notes/?q=test` | 301 到 `/category/notes/?q=test` |
| 新目標 URL | 不再命中同一舊址對照，不形成迴圈 |
| 帶 query 的實際 `/assets/…`、`/media/…` | 不被文章轉址清單誤攔，維持既有 R2 分流 |

模擬後仍需實際用瀏覽器或 `curl` 查看狀態碼、Location、query 與最終內容。上傳成功只代表網站產物已交付；正式網址自動驗證及 Rule Simulator 人工確認仍是不同驗收項目。

實際作者對照 CSV、搬移清單與部署紀錄應放在自己的私有維護位置，不把它們當通用範例一起公開。

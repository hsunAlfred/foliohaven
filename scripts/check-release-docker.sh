#!/usr/bin/env bash
# Host-only acceptance: creates a disposable, curated release workspace.
set -Eeuo pipefail
umask 077
release_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
command -v docker >/dev/null || { printf '%s\n' '此驗收須在具有 Docker 的主機執行。' >&2; exit 1; }
command -v curl >/dev/null || { printf '%s\n' '主機驗收需要 curl；一般使用只需 Docker。' >&2; exit 1; }
command -v node >/dev/null || { printf '%s\n' '發行工程驗收需要 Node.js；一般使用只需 Docker。' >&2; exit 1; }
[[ "$(id -u)" != 0 ]] || { printf '%s\n' '請以非 root 主機使用者執行。' >&2; exit 1; }
release_workspace="$(mktemp -d "${TMPDIR:-/tmp}/foliohaven-release-check.XXXXXXXX")"
release_project="foliohaven-release-check-$$"
release_private_root="$(node --input-type=module -e 'const {privateDirectoryName} = await import(process.argv[1]); process.stdout.write(privateDirectoryName(process.argv[2]));' "$release_source/scripts/workspace-paths.mjs" "$release_source")"
release_reports="$release_source/$release_private_root/reports/release-docker-host"
mkdir -p "$release_reports"
release_report="$(mktemp -d "$release_reports/$release_project.XXXXXXXX")"
release_log="$release_report/compose.log"
release_phase='準備驗收副本'
release_started=$SECONDS
release_success=false
release_docker_ready=false
# 外部 Compose 設定不得改用作者目錄、載入私人 env 或啟動額外服務。
unset COMPOSE_FILE COMPOSE_PROFILES COMPOSE_ENV_FILES COMPOSE_PROJECT_NAME \
  COMPOSE_PATH_SEPARATOR COMPOSE_CONVERT_WINDOWS_PATHS COMPOSE_REMOVE_ORPHANS \
  COMPOSE_COMPATIBILITY
export COMPOSE_DISABLE_ENV_FILE=1
compose() {
  docker compose --project-directory "$release_workspace" \
    --env-file "$release_workspace/.foliohaven/compose.env" \
    -f "$release_workspace/docker-compose.yml" -p "$release_project" "$@"
}
log() {
  printf '[%s][+%ss] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$((SECONDS - release_started))" "$*" | tee -a "$release_log"
}
phase() {
  release_phase="$*"
  log "$release_phase"
}
run_logged() {
  "$@" 2>&1 | tee -a "$release_log"
}
finish() {
  local release_code=$?
  local release_failed_phase="$release_phase"
  trap - EXIT INT TERM
  set +e
  if [[ "$release_success" == true && "$release_code" == 0 ]]; then
    phase '[12/12] 清理獨立驗收環境'
    run_logged compose --profile repair down --remove-orphans
    release_code=$?
    local release_images=()
    local release_image
    if [[ "$release_code" == 0 ]]; then
      docker image ls --format '{{.Repository}}:{{.Tag}}' "$release_project" > "$release_report/images.txt" 2>> "$release_log"
      release_code=$?
      while IFS= read -r release_image; do
        [[ -z "$release_image" ]] || release_images+=("$release_image")
      done < "$release_report/images.txt"
      if [[ "$release_code" == 0 ]] && (( ${#release_images[@]} )); then
        run_logged docker image rm "${release_images[@]}"
        release_code=$?
      fi
    fi
    if [[ "$release_code" != 0 ]]; then
      release_failed_phase="$release_phase"
    fi
  fi
  if [[ "$release_success" != true || "$release_code" != 0 ]]; then
    log "驗收失敗（exit $release_code）：$release_failed_phase"
    printf '%s\n' "$release_failed_phase" > "$release_report/failed-stage.txt"
    if [[ "$release_docker_ready" == true ]]; then
      compose --profile repair logs --no-color > "$release_report/containers.log" 2>&1 || true
      if run_logged compose stop app repair; then
        log "已停止並保留獨立 project $release_project 與工作副本 $release_workspace；未停止原開發容器。"
      else
        log "無法確認驗收容器停止狀態；請檢查獨立 project $release_project 與工作副本 $release_workspace。"
      fi
    else
      log "公開來源副本尚未就緒；未啟動 Docker，保留工作副本 $release_workspace。"
    fi
  fi
  if [[ -d "$release_workspace/.foliohaven/reports/release-docker-check" ]]; then
    cp -R "$release_workspace/.foliohaven/reports/release-docker-check" "$release_report/"
    local release_copy_code=$?
    if [[ "$release_code" == 0 && "$release_copy_code" != 0 ]]; then
      release_code=$release_copy_code
      log "報告複製失敗；保留工作副本 $release_workspace。"
    fi
  fi
  if [[ "$release_success" == true && "$release_code" == 0 ]]; then
    cd "$release_source" && rm -rf -- "$release_workspace"
    release_code=$?
    if [[ "$release_code" == 0 ]]; then
      log "Docker release 驗收通過；報告：$release_report"
    else
      log "清理工作副本失敗（exit $release_code）；請保留現場檢查。"
    fi
  fi
  log "報告：$release_report"
  exit "$release_code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
log "獨立 project：$release_project"
log "即時日誌：$release_log"
phase '[1/12] 建立乾淨來源副本'
run_logged node "$release_source/scripts/package-release.mjs" --directory "$release_workspace" --source "$release_source"
cd "$release_workspace"
mkdir -m 700 .foliohaven
: > .foliohaven/compose.env
printf '%s\n' '{"schemaVersion":1,"purpose":"release-validation"}' > .foliohaven/release-check-workspace.json
export LOCAL_UID="$(id -u)"
export LOCAL_GID="$(id -g)"
export RELEASE_IMAGE_NAME="$release_project"
export BUILDKIT_PROGRESS=plain
release_docker_ready=true
probe_host() {
  local release_port
  for release_port in "${SITE_PORT:-4321}" "${STUDIO_PORT:-5173}" "${PREVIEW_PORT:-4322}"; do
    log "檢查主機連線 127.0.0.1:$release_port（連線最多3秒，整次請求最多15秒）"
    run_logged curl --fail --silent --show-error --noproxy '*' --connect-timeout 3 --max-time 15 --output /dev/null \
      --write-out 'HTTP %{http_code}，耗時 %{time_total}s\n' "http://127.0.0.1:$release_port/"
  done
  log '確認管理 API 3001 沒有發布到主機'
  local release_container
  local release_api_port
  release_container="$(compose ps -q app 2>> "$release_log")"
  [[ -n "$release_container" ]] || { log '找不到驗收 app 容器。'; return 1; }
  release_api_port="$(docker inspect --format '{{json (index .HostConfig.PortBindings "3001/tcp")}}' "$release_container" 2>> "$release_log")"
  [[ "$release_api_port" == null || "$release_api_port" == '[]' ]] || { log 'API 3001 不應發布到主機。'; return 1; }
}
phase '[2/12] 檢查兩份 Compose 設定'
run_logged compose config -q
run_logged compose -f "$release_workspace/.devcontainer/docker-compose.yml" config -q
# Export as tar so the non-root host owns the extracted files even with a
# different UID from the builder image. The output stays outside Docker context.
phase '[3/12] 建置並匯出靜態網站（Docker 建置沒有固定總時限）'
run_logged docker build --progress plain --target dist-export \
  --build-arg "LOCAL_UID=$LOCAL_UID" --build-arg "LOCAL_GID=$LOCAL_GID" \
  --output "type=tar,dest=$release_workspace/.foliohaven/dist-export.tar" .
phase '[4/12] 檢查靜態輸出與私有檔案排除'
mkdir -m 700 .foliohaven/export-check
tar --no-same-owner -xf .foliohaven/dist-export.tar -C .foliohaven/export-check
for release_file in index.html 404.html rss.xml search-index.json sitemap-index.xml robots.txt; do
  [[ -s ".foliohaven/export-check/$release_file" ]] || { printf '靜態輸出缺少檔案：%s\n' "$release_file" >&2; exit 1; }
done
for release_private in .git .foliohaven .alfred .codex node_modules content media/source studio server; do
  [[ ! -e ".foliohaven/export-check/$release_private" ]] || { printf '靜態輸出包含私有來源：%s\n' "$release_private" >&2; exit 1; }
done
[[ -z "$(find .foliohaven/export-check -type l -print -quit)" ]] || { printf '%s\n' '靜態輸出不應包含符號連結。' >&2; exit 1; }
find .foliohaven/export-check -type f -print | sort > "$release_report/dist-export-files.txt"
phase '[5/12] 建置並首次啟動 release（啟動等待最多600秒）'
run_logged compose up -d --build --wait --wait-timeout 600
phase '[6/12] 檢查主機三個網址與 API 邊界'
probe_host
phase '[7/12] 真實上傳、處理圖片、新增發布文章並更新網站'
run_logged compose exec -T app node tests/release/docker-check.mjs prepare
probe_host
phase '[8/12] 停止驗收容器並重新建置 image'
run_logged compose down
run_logged compose build app
phase '[9/12] 重啟並驗證文章、媒體、工作與網站保存（啟動最多600秒）'
run_logged compose up -d --no-build --wait --wait-timeout 600
probe_host
run_logged compose exec -T app node tests/release/docker-check.mjs verify
phase '[10/12] 切換修復模式並驗健康（啟動最多600秒）'
run_logged compose stop app
run_logged compose up -d --no-build --wait --wait-timeout 600 repair
run_logged compose exec -T repair node scripts/healthcheck.mjs --studio
phase '[11/12] 回到一般模式並再次驗證保存結果（啟動最多600秒）'
run_logged compose stop repair
run_logged compose up -d --no-build --wait --wait-timeout 600 app
probe_host
run_logged compose exec -T app node tests/release/docker-check.mjs verify
# A dry-run makes a real Build and adds a job. Keep the original persistence
# baseline intact until both restart checks have finished; never refresh it to
# hide an unexpected change in an earlier author job.
phase '[11b/12] Cloudflare 完整本機 dry-run（最多30分鐘，不連線雲端）'
run_logged compose exec -T app node tests/release/cloudflare-docker-check.mjs
release_success=true

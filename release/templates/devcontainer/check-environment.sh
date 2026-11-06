#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf '環境檢查失敗：%s\n' "$1" >&2
  exit 1
}

trap 'printf "環境檢查失敗：第 %s 行的指令未成功。\n" "$LINENO" >&2' ERR

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# 可指定專案根目錄，供安裝範本前的檢查使用。
project_dir="$(cd -- "${1:-${script_dir}/..}" && pwd)"

[[ "$(id -u)" != "0" ]] || fail '請使用非 root 帳號。'
[[ "$(uname -s)" == 'Linux' ]] || fail '請使用 Linux 環境或專案提供的 Docker。'

for tool_name in node pnpm git bash curl ffmpeg ffprobe rg ssh python3 make g++ flock; do
  command -v "${tool_name}" >/dev/null 2>&1 || fail "找不到必要工具：${tool_name}。"
done

for required_file in AGENTS.md README.md .node-version package.json; do
  [[ -r "${project_dir}/${required_file}" ]] || fail "無法讀取專案檔案：${required_file}。"
done

actual_node_version="$(node --version)"
actual_pnpm_version="$(pnpm --version)"
expected_node_version="$(cat -- "${project_dir}/.node-version")"
expected_pnpm_version="$(node --input-type=module -e 'import fs from "node:fs"; const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).packageManager; if (typeof value !== "string" || !/^pnpm@[0-9]+\.[0-9]+\.[0-9]+$/.test(value)) process.exit(1); console.log(value.slice(5));' "${project_dir}/package.json")"
[[ "${actual_node_version}" == "v${expected_node_version}" ]] \
  || fail "Node.js 版本應為 v${expected_node_version}，實際為 ${actual_node_version}。"
[[ "${actual_pnpm_version}" == "${expected_pnpm_version}" ]] \
  || fail "pnpm 版本應為 ${expected_pnpm_version}，實際為 ${actual_pnpm_version}。"
[[ -w "${project_dir}" ]] || fail '工作目錄不可寫入，請檢查 UID／GID 與掛載權限。'

probe_file="$(mktemp "${project_dir}/.devcontainer-write-check.XXXXXX")"
trap 'rm -f -- "${probe_file}"' EXIT
printf 'workspace-write-check\n' > "${probe_file}"
[[ "$(cat -- "${probe_file}")" == 'workspace-write-check' ]] || fail '工作目錄讀寫結果不一致。'

printf 'Node.js: %s\n' "${actual_node_version}"
printf 'pnpm: %s\n' "${actual_pnpm_version}"
printf '使用者：%s，UID=%s，GID=%s\n' "$(id -un)" "$(id -u)" "$(id -g)"
printf '必要工具、非 root 與工作目錄讀寫檢查通過。\n'

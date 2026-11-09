#!/usr/bin/env bash
# Focused foreign-UID acceptance against a prebuilt release image. No host ports.
set -Eeuo pipefail
umask 077
uid_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
uid_expected=''
gid_expected=''
uid_image=''
while (( $# )); do
  [[ $# -ge 2 ]] || { printf '%s\n' '請提供 --uid UID --gid GID --image 已建立的映像。' >&2; exit 1; }
  case "$1" in
    --uid) [[ -z "$uid_expected" ]] || exit 1; uid_expected="$2" ;;
    --gid) [[ -z "$gid_expected" ]] || exit 1; gid_expected="$2" ;;
    --image) [[ -z "$uid_image" ]] || exit 1; uid_image="$2" ;;
    *) printf '%s\n' '未知的 UID 驗收參數。' >&2; exit 1 ;;
  esac
  shift 2
done
for uid_number in "$uid_expected" "$gid_expected"; do
  [[ "$uid_number" =~ ^[1-9][0-9]{0,9}$ ]] && (( uid_number <= 2147483647 )) || { printf '%s\n' 'UID／GID 必須為 1–2147483647 的十進位整數。' >&2; exit 1; }
done
[[ "$uid_image" =~ ^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$ ]] || { printf '%s\n' '請指定本機已建立的 release 映像。' >&2; exit 1; }
for uid_command in docker node tar; do
  command -v "$uid_command" >/dev/null || { printf 'UID 驗收需要 %s。\n' "$uid_command" >&2; exit 1; }
done
[[ "$(id -u)" != 0 ]] || { printf '%s\n' '請使用非 root 主機帳號；初始化僅操作獨立 volume。' >&2; exit 1; }
uid_private="$(node --input-type=module -e 'const {privateResource}=await import(process.argv[1]);process.stdout.write(privateResource(process.argv[2],"reports/release-uid-check"));' "$uid_source/scripts/workspace-paths.mjs" "$uid_source")"
uid_reports="$uid_source/$uid_private"
mkdir -p "$uid_reports"
uid_report="$(mktemp -d "$uid_reports/uid-$uid_expected-$gid_expected.XXXXXXXX")"
uid_log="$uid_report/commands.log"
uid_steps="$uid_report/steps.jsonl"
uid_work="$(mktemp -d "${TMPDIR:-/tmp}/foliohaven-release-uid.XXXXXXXX")"
uid_workspace="$uid_work/source"
uid_run="$(basename -- "$uid_work")"
uid_volume="$uid_run-workspace"
uid_current=''
uid_first=''
uid_second=''
uid_volume_created=false
uid_success=false
uid_phase='arguments'
uid_image_id=''
uid_public_digest=''
uid_final_stopped=false
: > "$uid_log"
: > "$uid_steps"
log() { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" | tee -a "$uid_log"; }
phase() { uid_phase="$1"; log "$uid_phase"; }
passed() { printf '{"phase":"%s","status":"passed"}\n' "$uid_phase" >> "$uid_steps"; }
run_logged() { "$@" 2>&1 | tee -a "$uid_log"; }
owned_container() {
  [[ "$(docker inspect --format '{{ index .Config.Labels "foliohaven.uid-check-id" }}' "$uid_current" 2>> "$uid_log")" == "$uid_run" ]]
}
finish() {
  local uid_code=$?
  local uid_cleanup_code=0
  trap - EXIT INT TERM
  set +e
  if [[ -n "$uid_current" ]]; then
    if owned_container; then
      docker logs "$uid_current" > "$uid_report/container.log" 2>&1
      docker stop --time 60 "$uid_current" >> "$uid_log" 2>&1
      local uid_stop_code=$?
      if [[ "$uid_stop_code" == 0 && "$(docker inspect --format '{{.State.ExitCode}}' "$uid_current" 2>> "$uid_log")" == 0 ]]; then
        uid_final_stopped=true
        docker rm "$uid_current" >> "$uid_log" 2>&1
      else
        uid_cleanup_code=1
        docker rm --force "$uid_current" >> "$uid_log" 2>&1
      fi
      local uid_remove_code=$?
      [[ "$uid_remove_code" == 0 ]] || uid_cleanup_code="$uid_remove_code"
    else
      log '無法證明驗收容器歸屬，未停止或刪除該容器。'
      uid_cleanup_code=1
    fi
  fi
  if [[ "$uid_volume_created" == true ]]; then
    if [[ "$(docker volume inspect --format '{{ index .Labels "foliohaven.uid-check-id" }}' "$uid_volume" 2>> "$uid_log")" == "$uid_run" ]]; then
      docker volume rm "$uid_volume" >> "$uid_log" 2>&1
      local uid_volume_code=$?
      [[ "$uid_volume_code" == 0 ]] || uid_cleanup_code="$uid_volume_code"
    else
      log '無法證明驗收 volume 歸屬，未刪除該 volume。'
      uid_cleanup_code=1
    fi
  fi
  if [[ "$uid_cleanup_code" == 0 ]]; then
    printf '%s\n' '{"phase":"cleanup","status":"passed"}' >> "$uid_steps"
  else
    printf '%s\n' '{"phase":"cleanup","status":"failed"}' >> "$uid_steps"
    [[ "$uid_code" != 0 ]] || uid_code="$uid_cleanup_code"
  fi
  [[ "$uid_success" == true || "$uid_code" != 0 ]] || uid_code=1
  if [[ "$uid_code" == 0 && "$uid_success" == true ]]; then
    rm -rf -- "$uid_work"
    local uid_work_code=$?
    [[ "$uid_work_code" == 0 ]] || uid_code="$uid_work_code"
  fi
  node --input-type=module - "$uid_report" "$uid_reports" "$uid_expected" "$gid_expected" "$uid_code" "$uid_phase" "$uid_image_id" "$uid_public_digest" "$uid_first" "$uid_second" "$uid_final_stopped" <<'REPORT'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
const [directory, reports, uid, gid, exit, phase, imageId, publicSourceDigest, firstContainer, restartedContainer, finalStopped] = process.argv.slice(2);
const reportPath = join(directory, 'result.json');
const result = {schemaVersion:1,scope:'docker-uid',status:exit==='0'?'passed':'failed',exitCode:Number(exit),uid:Number(uid),gid:Number(gid),phase,imageId,publicSourceDigest,firstContainer,restartedContainer,network:'none',hostPortsPublished:false,steps:readFileSync(join(directory,'steps.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)),checkedAt:new Date().toISOString()};
if (result.exitCode===0) {
  try {
    const read = name => JSON.parse(readFileSync(join(directory,name),'utf8'));
    const bootstrap=read('bootstrap.json'), identity=read('identity.json'), prepare=read('prepare.json'), verify=read('verify.json');
    for(const report of [bootstrap,identity]) {
      assert.equal(report.schemaVersion,1);assert.equal(report.status,'passed');assert.equal(report.uid,result.uid);assert.equal(report.gid,result.gid);
    }
    for(const report of [prepare,verify]) {
      assert.equal(report.scope,'docker');assert.equal(report.environment.uid,result.uid);assert.equal(report.environment.gid,result.gid);
    }
    assert.equal(prepare.mode,'prepare');assert.equal(verify.mode,'verify');
    const phases=['image','source','volume','seed','bootstrap','first-start','author-save-build','first-stop','restart','preserved','cleanup'];
    assert.deepEqual(result.steps.map(x=>x.phase),phases);
    assert.ok(result.steps.every(x=>x.status==='passed'));
    result.checks={
      coldDependencies:bootstrap.emptyDependencies===true&&bootstrap.emptyDist===true,
      offlineWarmStore:bootstrap.warmStoreWritable===true&&result.network==='none',
      nonRootIdentity:result.uid>0&&result.gid>0&&bootstrap.browsersOwned===true,
      realFlock:bootstrap.realFlock===true,
      privateStateOwned:identity.privateStateOwned===true&&identity.dependenciesOwned===true,
      articleSaved:prepare.articleSaved===true&&verify.articleSaved===true&&identity.savedArticleAndMedia===true,
      mediaSaved:prepare.mediaSaved===true&&verify.mediaSaved===true,
      successfulBuildPreserved:prepare.artifactUnchanged===true&&verify.artifactUnchanged===true&&identity.successfulBuildPreserved===true,
      restartedContainer:/^[a-f0-9]{64}$/.test(firstContainer)&&/^[a-f0-9]{64}$/.test(restartedContainer)&&firstContainer!==restartedContainer,
      gracefulStop:finalStopped==='true',
      ownResourcesRemoved:result.steps.at(-1)?.status==='passed',
    };
    assert.ok(Object.values(result.checks).every(x=>x===true));
    assert.match(imageId,/^sha256:[a-f0-9]{64}$/);assert.match(publicSourceDigest,/^[a-f0-9]{64}$/);
  } catch {
    result.status='failed';result.exitCode=1;result.errorCode='UID_ACCEPTANCE_EVIDENCE_INVALID';
  }
}
writeFileSync(reportPath,JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
const pointer=join(reports,`latest-${uid}-${gid}.json`);
const temporary=pointer+`.${process.pid}.tmp`;
writeFileSync(temporary,JSON.stringify({status:result.status,uid:result.uid,gid:result.gid,reportPath})+'\n',{mode:0o600,flag:'wx'});
renameSync(temporary,pointer);
console.log(JSON.stringify({status:result.status,uid:result.uid,gid:result.gid,reportPath}));
process.exitCode=result.exitCode===0?0:1;
REPORT
  local uid_report_code=$?
  [[ "$uid_report_code" == 0 ]] || { [[ "$uid_code" != 0 ]] || uid_code="$uid_report_code"; }
  exit "$uid_code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
phase image
uid_image_id="$(docker image inspect --format '{{.Id}}' "$uid_image" 2>> "$uid_log")"
[[ "$uid_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || { log '找不到有效的本機 release image ID。'; exit 1; }
passed
phase source
run_logged node "$uid_source/scripts/package-release.mjs" --directory "$uid_workspace" --source "$uid_source"
uid_public_digest="$(node --input-type=module -e 'import{readFileSync}from"node:fs";import{createHash}from"node:crypto";process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"));' "$uid_workspace/release-info.json")"
passed
phase volume
if docker volume inspect "$uid_volume" >/dev/null 2>&1; then log '驗收 volume 名稱已存在，拒絕重用。'; exit 1; fi
run_logged docker volume create --label "foliohaven.uid-check-id=$uid_run" "$uid_volume"
[[ "$(docker volume inspect --format '{{ index .Labels "foliohaven.uid-check-id" }}' "$uid_volume")" == "$uid_run" ]]
uid_volume_created=true
# The only ownership adjustment touches the root of our new empty Docker volume.
run_logged docker run --rm --pull=never --network none --user 0:0 \
  --mount "type=volume,source=$uid_volume,target=/workspaces/foliohaven,volume-nocopy" \
  --entrypoint node "$uid_image_id" --input-type=module -e \
  'import assert from "node:assert/strict";import{readdirSync,chownSync,chmodSync}from"node:fs";const p="/workspaces/foliohaven";assert.deepEqual(readdirSync(p),[]);chownSync(p,Number(process.argv[1]),Number(process.argv[2]));chmodSync(p,0o700);' "$uid_expected" "$gid_expected"
passed
phase seed
tar -C "$uid_workspace" -cf - . | docker run --rm --pull=never --network none --interactive --user node \
  --mount "type=volume,source=$uid_volume,target=/workspaces/foliohaven,volume-nocopy" \
  --entrypoint tar "$uid_image_id" --extract --no-same-owner --same-permissions --no-overwrite-dir --directory /workspaces/foliohaven >> "$uid_log" 2>&1
passed
phase bootstrap
run_logged docker run --rm --pull=never --network none --user node \
  --mount "type=volume,source=$uid_volume,target=/workspaces/foliohaven,volume-nocopy" \
  --entrypoint node "$uid_image_id" tests/release/uid-check.mjs bootstrap "$uid_expected" "$gid_expected"
passed
start_app() {
  uid_current="$(docker run --detach --pull=never --init --network none --user node --shm-size=1g --stop-timeout 60 \
    --label "foliohaven.uid-check-id=$uid_run" --name "$uid_run-$1" \
    --mount "type=volume,source=$uid_volume,target=/workspaces/foliohaven,volume-nocopy" \
    --health-cmd 'node scripts/healthcheck.mjs --release' --health-interval 5s --health-timeout 8s --health-start-period 600s --health-retries 3 \
    "$uid_image_id" 2>> "$uid_log")"
  [[ "$uid_current" =~ ^[a-f0-9]{64}$ ]] || { log '未取得有效驗收容器 ID。'; exit 1; }
  local uid_deadline=$((SECONDS + 600))
  local uid_state
  while (( SECONDS < uid_deadline )); do
    uid_state="$(docker inspect --format '{{.State.Running}} {{.State.Health.Status}}' "$uid_current")"
    [[ "$uid_state" == 'true healthy' ]] && return 0
    [[ "$uid_state" == 'true starting' ]] || { log "驗收服務未就緒：$uid_state"; return 1; }
    sleep 2
  done
  log 'UID 驗收服務啟動逾時。'
  return 1
}
phase first-start
start_app first
uid_first="$uid_current"
passed
phase author-save-build
run_logged docker exec "$uid_current" node tests/release/docker-check.mjs prepare
run_logged docker cp "$uid_current:/workspaces/foliohaven/.foliohaven/reports/release-docker-check/prepare.json" "$uid_report/prepare.json"
passed
phase first-stop
owned_container
run_logged docker stop --time 60 "$uid_current"
[[ "$(docker inspect --format '{{.State.ExitCode}}' "$uid_current")" == 0 ]] || { log '首次作者程序未正常退出。'; exit 1; }
run_logged docker rm "$uid_current"
uid_current=''
passed
phase restart
start_app restarted
uid_second="$uid_current"
[[ "$uid_second" != "$uid_first" ]]
passed
phase preserved
run_logged docker exec "$uid_current" node tests/release/docker-check.mjs verify
run_logged docker exec "$uid_current" node tests/release/uid-check.mjs verify "$uid_expected" "$gid_expected"
for uid_file in bootstrap.json identity.json; do
  run_logged docker cp "$uid_current:/workspaces/foliohaven/.foliohaven/reports/release-uid-check/$uid_file" "$uid_report/$uid_file"
done
run_logged docker cp "$uid_current:/workspaces/foliohaven/.foliohaven/reports/release-docker-check/verify.json" "$uid_report/verify.json"
passed
uid_success=true

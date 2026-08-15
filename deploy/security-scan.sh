#!/usr/bin/env bash
set -Eeuo pipefail
STATE_DIR=${STATE_DIR:-/var/lib/vps-sentinel}; POLICY="$STATE_DIR/security-scan-policy.json"; STATUS="$STATE_DIR/security-scan-status.json"; REPORTS="$STATE_DIR/security-scans"; FORCE="$STATE_DIR/security-scan-force"
install -d -m 750 -o root -g vpssentinel "$REPORTS"; exec 9>"$STATE_DIR/security-scan.lock"; flock -n 9 || exit 0
value(){ node -e "let p={};try{p=require(process.argv[1])}catch{};process.stdout.write(String(p[process.argv[2]]??''))" "$POLICY" "$1"; }
status(){ STATUS_VALUE="$1" MESSAGE="$2" REPORT_ID="${3:-}" node - "$STATUS" <<'NODE'
const fs=require('fs'),f=process.argv[2];let p={};try{p=JSON.parse(fs.readFileSync(f))}catch{};const n={...p,status:process.env.STATUS_VALUE,running:process.env.STATUS_VALUE==='running',message:process.env.MESSAGE,reportId:process.env.REPORT_ID||p.reportId||null,updatedAt:Date.now()};fs.writeFileSync(f,JSON.stringify(n));fs.chmodSync(f,0o640)
NODE
chown root:vpssentinel "$STATUS"; }
enabled=$(value enabled); frequency=$(value frequency); forced=false; [[ -f $FORCE ]] && { forced=true; rm -f "$FORCE"; }
if [[ $forced != true ]]; then [[ $enabled == true && $frequency != manual ]] || exit 0; if [[ $frequency == weekly && -f $STATUS ]]; then last=$(node -e "let s=require(process.argv[1]);process.stdout.write(String(s.finishedAt||0))" "$STATUS" 2>/dev/null || echo 0); (( $(date +%s000)-last >= 518400000 )) || exit 0; fi; fi
id=$(date -u +%Y%m%dT%H%M%SZ); log="$REPORTS/$id.log"; report="$REPORTS/$id.json"; started=$(date +%s000); status running 'Проверка выполняется' "$id"
trap 'status cancelled "Проверка остановлена" "$id"; exit 143' TERM INT
printf 'Grouvi Nox security scan\nStarted: %s\n' "$(date -u +%FT%TZ)" >"$log"; chmod 640 "$log"; chown root:vpssentinel "$log"
missing=''
fresh=127; if command -v freshclam >/dev/null; then systemctl stop clamav-freshclam.service >/dev/null 2>&1 || true; set +e; freshclam --quiet >>"$log" 2>&1; fresh=$?; set -e; systemctl start clamav-freshclam.service >/dev/null 2>&1 || true; fi
rkh_ok=false; rkh=127; if command -v rkhunter >/dev/null; then rkh_ok=true; echo '=== rkhunter ===' >>"$log"; set +e; rkhunter --check --skip-keypress --nocolors >>"$log" 2>&1; rkh=$?; set -e; else missing="rkhunter"; echo '=== rkhunter is not installed, skipped ===' >>"$log"; fi
roots=(); for p in /etc /opt /root /home /srv /var/www /usr/local /tmp /var/tmp; do [[ -e $p ]] && roots+=("$p"); done
# ClamAV needs its whole signature set resident. On a host below the floor it is
# deliberately absent rather than broken, so its absence must not be reported as
# an incomplete scan forever. Keep these numbers in step with deploy/lib/common.sh.
clam_min_mem_mb=2400; clam_min_disk_mb=3000
mem_mb=$(awk '/^MemTotal:/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || printf '0')
disk_mb=$(df -Pm /var/lib 2>/dev/null | awk 'NR==2{printf "%d", $4}' || printf '0')
clam_expected=true; clam_ok=false; clam=127
if command -v clamscan >/dev/null; then
  clam_ok=true; echo '=== ClamAV ===' >>"$log"; set +e; clamscan -r --infected --cross-fs=no --exclude-dir='^/var/lib/(docker|containerd)(/|$)' --exclude-dir='^/var/lib/vps-sentinel/security-scans(/|$)' "${roots[@]}" >>"$log" 2>&1; clam=$?; set -e
elif (( ${mem_mb:-0} < clam_min_mem_mb || ${disk_mb:-0} < clam_min_disk_mb )); then
  clam_expected=false; printf '=== ClamAV not applicable: host has %sM RAM and %sM free disk, below the %sM/%sM floor ===\n' "$mem_mb" "$disk_mb" "$clam_min_mem_mb" "$clam_min_disk_mb" >>"$log"
else
  missing="${missing:+$missing, }clamav"; echo '=== ClamAV is not installed, skipped ===' >>"$log"
fi
# An engine killed by the kernel (128+signal, typically 137 for OOM) produced no verdict at all.
[[ $clam_ok == true && $clam -ge 128 ]] && { clam_ok=false; missing="${missing:+$missing, }clamav (прерван, код $clam)"; }
[[ $rkh_ok == true && $rkh -ge 128 ]] && { rkh_ok=false; missing="${missing:+$missing, }rkhunter (прерван, код $rkh)"; }
engines_complete=true
[[ $rkh_ok == true ]] || engines_complete=false
[[ $clam_ok == true || $clam_expected == false ]] || engines_complete=false
# One awk, no pipeline: under `set -e` with pipefail a grep that matches nothing
# returns 1, which aborted the whole scan before any report was written and left
# the status file pinned at running:true forever. That is exactly what happens
# when ClamAV is absent and its summary lines never reach the log.
num(){ awk -v key="^$1:" '$0 ~ key {found=$3+0} END{print found+0}' "$log"; }; infected=$(num 'Infected files'); scanned=$(num 'Scanned files'); known=$(num 'Known viruses'); rootkits=$(num 'Possible rootkits'); warnings=$(grep -Ec '(\[ Warning \]|Warning:)' "$log" || true); infected=${infected:-0}; scanned=${scanned:-0}; known=${known:-0}; rootkits=${rootkits:-0}; warnings=${warnings:-0}
# Order matters: an engine that never ran cannot vouch for a clean host, and a
# real detection outranks a noisy exit code.
result=clean
[[ $clam -gt 1 || $rkh -gt 1 ]] && result=warnings
[[ $engines_complete == true ]] || result=unavailable
[[ $infected -gt 0 || $rootkits -gt 0 ]] && result=threats
finished=$(date +%s000)
ID="$id" STARTED="$started" FINISHED="$finished" RESULT="$result" CLAM="$clam" RKH="$rkh" FRESH="$fresh" INFECTED="$infected" SCANNED="$scanned" KNOWN="$known" ROOTKITS="$rootkits" WARNINGS="$warnings" CLAM_OK="$clam_ok" RKH_OK="$rkh_ok" CLAM_EXPECTED="$clam_expected" MISSING="$missing" node - "$report" <<'NODE'
const fs=require('fs'),f=process.argv[2],n=k=>Number(process.env[k]||0),b=k=>process.env[k]==='true';const r={schema:2,id:process.env.ID,startedAt:n('STARTED'),finishedAt:n('FINISHED'),result:process.env.RESULT,missingEngines:process.env.MISSING||'',clamav:{available:b('CLAM_OK'),expected:b('CLAM_EXPECTED'),exitCode:n('CLAM'),infected:n('INFECTED'),scannedFiles:n('SCANNED'),knownViruses:n('KNOWN'),databaseUpdateExit:n('FRESH')},rkhunter:{available:b('RKH_OK'),expected:true,exitCode:n('RKH'),possibleRootkits:n('ROOTKITS'),warnings:n('WARNINGS')}};fs.writeFileSync(f,JSON.stringify(r,null,2));fs.chmodSync(f,0o640)
NODE
chown root:vpssentinel "$report"; printf '\nFinished: %s\nResult: %s\n' "$(date -u +%FT%TZ)" "$result" >>"$log"
find "$REPORTS" -maxdepth 1 -name '*.json' -printf '%T@ %p\n' | sort -rn | awk 'NR>10{$1="";sub(/^ /,"");print}' | while read -r old; do rm -f "$old" "${old%.json}.log"; done
FINISHED="$finished" RESULT="$result" MISSING="$missing" node - "$STATUS" "$id" "$started" <<'NODE'
const fs=require('fs'),f=process.argv[2],result=process.env.RESULT,missing=process.env.MISSING||'';
const message=result==='clean'?'Угроз не обнаружено':result==='threats'?'Найдены угрозы, нужен разбор':result==='unavailable'?`Проверка неполная, не установлен: ${missing||'сканер'}`:'Проверка завершена с предупреждениями';
fs.writeFileSync(f,JSON.stringify({status:result,running:false,message,missingEngines:missing,reportId:process.argv[3],startedAt:Number(process.argv[4]),finishedAt:Number(process.env.FINISHED),updatedAt:Date.now()}));fs.chmodSync(f,0o640)
NODE
chown root:vpssentinel "$STATUS"

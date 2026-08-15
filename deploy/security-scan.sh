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
id=$(date -u +%Y%m%dT%H%M%SZ); log="$REPORTS/$id.log"; report="$REPORTS/$id.json"; started=$(date +%s000); status running 'Security scan is running' "$id"
trap 'status cancelled "Security scan was cancelled" "$id"; exit 143' TERM INT
printf 'Grouvi Nox security scan\nStarted: %s\n' "$(date -u +%FT%TZ)" >"$log"; chmod 640 "$log"; chown root:vpssentinel "$log"
fresh=127; if command -v freshclam >/dev/null; then systemctl stop clamav-freshclam.service >/dev/null 2>&1 || true; set +e; freshclam --quiet >>"$log" 2>&1; fresh=$?; set -e; systemctl start clamav-freshclam.service >/dev/null 2>&1 || true; fi
rkh=127; if command -v rkhunter >/dev/null; then echo '=== rkhunter ===' >>"$log"; set +e; rkhunter --check --skip-keypress --nocolors >>"$log" 2>&1; rkh=$?; set -e; fi
roots=(); for p in /etc /opt /root /home /srv /var/www /usr/local /tmp /var/tmp; do [[ -e $p ]] && roots+=("$p"); done
clam=127; if command -v clamscan >/dev/null; then echo '=== ClamAV ===' >>"$log"; set +e; clamscan -r --infected --cross-fs=no --exclude-dir='^/var/lib/(docker|containerd)(/|$)' --exclude-dir='^/var/lib/vps-sentinel/security-scans(/|$)' "${roots[@]}" >>"$log" 2>&1; clam=$?; set -e; fi
num(){ grep -E "^$1:" "$log" | tail -1 | awk '{print $3+0}'; }; infected=$(num 'Infected files'); scanned=$(num 'Scanned files'); known=$(num 'Known viruses'); rootkits=$(num 'Possible rootkits'); warnings=$(grep -Ec '(\[ Warning \]|Warning:)' "$log" || true); infected=${infected:-0}; scanned=${scanned:-0}; known=${known:-0}; rootkits=${rootkits:-0}; warnings=${warnings:-0}; result=clean; [[ $infected -gt 0 || $rootkits -gt 0 ]] && result=threats; [[ $clam -gt 1 || $rkh -gt 1 ]] && result=warnings; finished=$(date +%s000)
ID="$id" STARTED="$started" FINISHED="$finished" RESULT="$result" CLAM="$clam" RKH="$rkh" FRESH="$fresh" INFECTED="$infected" SCANNED="$scanned" KNOWN="$known" ROOTKITS="$rootkits" WARNINGS="$warnings" node - "$report" <<'NODE'
const fs=require('fs'),f=process.argv[2],n=k=>Number(process.env[k]||0);const r={schema:1,id:process.env.ID,startedAt:n('STARTED'),finishedAt:n('FINISHED'),result:process.env.RESULT,clamav:{exitCode:n('CLAM'),infected:n('INFECTED'),scannedFiles:n('SCANNED'),knownViruses:n('KNOWN'),databaseUpdateExit:n('FRESH')},rkhunter:{exitCode:n('RKH'),possibleRootkits:n('ROOTKITS'),warnings:n('WARNINGS')}};fs.writeFileSync(f,JSON.stringify(r,null,2));fs.chmodSync(f,0o640)
NODE
chown root:vpssentinel "$report"; printf '\nFinished: %s\nResult: %s\n' "$(date -u +%FT%TZ)" "$result" >>"$log"
find "$REPORTS" -maxdepth 1 -name '*.json' -printf '%T@ %p\n' | sort -rn | awk 'NR>10{$1="";sub(/^ /,"");print}' | while read -r old; do rm -f "$old" "${old%.json}.log"; done
FINISHED="$finished" RESULT="$result" node - "$STATUS" "$id" "$started" <<'NODE'
const fs=require('fs'),f=process.argv[2],result=process.env.RESULT;fs.writeFileSync(f,JSON.stringify({status:result,running:false,message:result==='clean'?'No threats detected':result==='threats'?'Threats require review':'Scan completed with warnings',reportId:process.argv[3],startedAt:Number(process.argv[4]),finishedAt:Number(process.env.FINISHED),updatedAt:Date.now()}));fs.chmodSync(f,0o640)
NODE
chown root:vpssentinel "$STATUS"

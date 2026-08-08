#!/usr/bin/env bash
set -Eeuo pipefail
STATE=${SENTINEL_STATE_DIR:-/var/lib/vps-sentinel}
AI_STATE=${SENTINEL_AI_STATE_DIR:-/var/lib/sentinel-ai}
OUT="$AI_STATE/context/VPS.md"
PROJECTS="$AI_STATE/context/projects.json"
install -d -m 750 -o sentinel-ai -g sentinel-ai "$AI_STATE/context" "$AI_STATE/workspace/repos"
node - "$STATE/discovery.json" "$PROJECTS.tmp" <<'NODE'
const fs=require('fs'),path=require('path'),crypto=require('crypto'),[input,output]=process.argv.slice(2);let d={items:[]},settings={enabledIds:[],disabledIds:[],preferences:{autoEnableConfidence:.75}};try{d=JSON.parse(fs.readFileSync(input,'utf8'))}catch{}try{settings=JSON.parse(fs.readFileSync(path.join(path.dirname(input),'discovery-settings.json'),'utf8'))}catch{}const on=new Set(settings.enabledIds||[]),off=new Set(settings.disabledIds||[]),threshold=Number(settings.preferences?.autoEnableConfidence||.75);const enabled=x=>on.has(x.id)||(!off.has(x.id)&&x.defaultEnabled&&x.confidence>=threshold);const related=project=>d.items.some(x=>x.type!=='project'&&enabled(x)&&[x.path,x.meta?.cwd,x.meta?.workingDir,x.meta?.workingDirectory,x.meta?.projectPath].some(value=>typeof value==='string'&&(value===project.path||value.startsWith(project.path+'/'))));const rows=d.items.filter(x=>x.type==='project'&&x.path&&enabled(x)&&related(x)&&fs.existsSync(`${x.path}/.git`)).slice(0,30).map(x=>({id:x.id,name:x.name,path:x.path,workspace:`/var/lib/sentinel-ai/workspace/repos/${crypto.createHash('sha256').update(x.id).digest('hex').slice(0,16)}`}));fs.writeFileSync(output,JSON.stringify(rows,null,2));
NODE
while IFS=$'\t' read -r live work; do
  [[ -d "$live/.git" ]] || continue
  if [[ ! -d "$work/.git" ]]; then rm -rf "$work"; git clone --no-hardlinks --no-local --quiet "$live" "$work" 2>/dev/null || continue
  elif [[ -z "$(git -C "$work" status --porcelain 2>/dev/null | head -1)" ]]; then git -C "$work" fetch --quiet --no-tags "$live" HEAD 2>/dev/null && git -C "$work" reset --quiet --hard FETCH_HEAD 2>/dev/null || true
  fi
  chown -R sentinel-ai:sentinel-ai "$work"
done < <(node -e "const fs=require('fs');for(const x of JSON.parse(fs.readFileSync(process.argv[1],'utf8')))console.log(x.path+'\\t'+x.workspace)" "$PROJECTS.tmp")
install -m 640 -o sentinel-ai -g sentinel-ai "$PROJECTS.tmp" "$PROJECTS"; rm -f "$PROJECTS.tmp"
TMP=$(mktemp);trap 'rm -f "$TMP"' EXIT
{
 echo '# VPS operational context';echo;echo "Generated: $(date -u +%FT%TZ)";echo "Host: $(hostname)";echo "OS: $(. /etc/os-release; echo "$PRETTY_NAME")";echo "Kernel: $(uname -r)";echo "Uptime: $(uptime -p)";echo
 echo '## Capacity';free -h;echo;df -h -x tmpfs -x devtmpfs -x overlay;echo
 echo '## Failed systemd units';systemctl --failed --no-legend --no-pager || true;echo
 echo '## Application services';systemctl list-units --type=service --state=running,failed --no-legend --no-pager | head -120 || true;echo
 echo '## Docker containers';docker ps -a --format '{{.Names}} | {{.Image}} | {{.Status}}' 2>/dev/null | sort || true;echo
 echo '## PM2 processes';HOME=/root pm2 jlist 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(f"{p.get(chr(110)+chr(97)+chr(109)+chr(101))} | {p.get(chr(112)+chr(109)+chr(50)+chr(95)+chr(101)+chr(110)+chr(118),{}).get(chr(115)+chr(116)+chr(97)+chr(116)+chr(117)+chr(115))}") for p in d]' || true;echo
 echo '## Open Sentinel incidents';sqlite3 "$STATE/sentinel.db" "select severity||' | '||incident_key||' | '||title from incidents where status!='resolved' order by first_seen desc limit 50;" 2>/dev/null || true;echo
 echo '## Discovered Git projects';node -e "const fs=require('fs');for(const x of JSON.parse(fs.readFileSync(process.argv[1],'utf8')))console.log(x.name+' | '+x.path+' | workspace='+x.workspace)" "$PROJECTS" 2>/dev/null || true;echo
 echo '## Nginx hostnames';{ nginx -T 2>/dev/null || true; } | awk '/server_name/{for(i=2;i<=NF;i++) if($i!="_") print $i}' | tr -d ';' | sort -u;echo
 echo '## Network listeners';ss -H -lntup | sed -E 's/users:\(.*//';echo
 echo '## Safety boundaries';echo '- Operational metadata only. Secrets, environment files, credentials, and file contents are excluded.';echo '- Production repositories are not writable. Editable copies live under the isolated Forge workspace.';echo '- Production changes, package changes, restarts, firewall, SSH, and user management are prohibited.'
} >"$TMP"
install -m 640 -o sentinel-ai -g sentinel-ai "$TMP" "$OUT"
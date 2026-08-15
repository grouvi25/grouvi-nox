import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=file=>fs.readFileSync(new URL(`../../${file}`,import.meta.url),'utf8');
test('security scanner is isolated and bounded',()=>{const unit=read('deploy/vps-sentinel-security.service'),script=read('deploy/security-scan.sh');assert.match(unit,/CPUQuota=25%/);assert.match(unit,/MemoryHigh=1800M/);assert.match(unit,/MemoryMax=2400M/);assert.doesNotMatch(unit,/MemoryMax=900M/,'ClamAV cannot load its signature set under 1G and would be OOM-killed on every run');assert.match(unit,/IOSchedulingClass=idle/);assert.match(unit,/NoNewPrivileges=true/);assert.match(unit,/ProtectSystem=strict/);assert.match(unit,/KillMode=control-group/);assert.match(script,/flock -n/);assert.match(script,/exclude-dir=.*docker/)});
test('scanner API is authenticated, same-origin and brokered',()=>{const route=read('src/routes/api/security-scans.js'),client=read('src/integration-client.js'),broker=read('bin/integration-config-broker.js');assert.match(route,/requireSameOrigin/);assert.match(route,/actionLimit/);assert.match(client,/securityScanStatus/);assert.match(broker,/security-scan-policy\.json/)});

/* A host that was never scanned must not be presented as a host that was found clean. */
test('a scan that could not run every engine never reports clean',()=>{
  const script=read('deploy/security-scan.sh');
  const order=['result=warnings','result=unavailable','result=threats'].map(marker=>script.indexOf(marker));
  assert.ok(order.every(index=>index>=0),'every verdict must be reachable');
  assert.deepEqual([...order].sort((a,b)=>a-b),order,'threats must outrank unavailable, and unavailable must outrank warnings');
  assert.match(script,/\[\[ \$engines_complete == true \]\] \|\| result=unavailable/);
  assert.match(script,/-ge 128/,'an engine killed by the kernel returned no verdict and must not count as one');
  assert.match(script,/missingEngines/,'the report has to name what did not run');
  assert.match(script,/set -Eeuo pipefail/);
  assert.match(script,/grep -qE '\^\[\[:space:\]\]\*Possible rootkits:'/,'exit codes lie: rkhunter returned 1 for "cannot write my logfile", so an engine counts only when it printed its own summary');
  assert.match(script,/grep -qE '\^\[\[:space:\]\]\*Infected files:'/,'clamscan returned 2 for "no signature database" and it was filed as an ordinary warning');
  assert.match(script,/key="\^\[\[:space:\]\]\*\$1:"/,'rkhunter indents its summary by four spaces, so an anchored ^ read every rootkit and suspect-file count as 0');
  assert.match(script,/suspectFiles/,'rkhunter reports changed file properties and they were never surfaced');
  assert.match(script,/ls \/var\/lib\/clamav\/\*\.c\[vl\]d/,'an empty signature directory must be caught before the scan claims a verdict');
  assert.match(script,/--logfile "\$REPORTS\/\$id\.rkhunter\.log"/,'/var/log is read-only under ProtectSystem=strict and rkhunter aborts when it cannot open its log');
  assert.match(read('deploy/vps-sentinel-security.service'),/ReadWritePaths=.*-\/var\/lib\/rkhunter/);
  assert.match(script,/\$clam_expected == true && \$clam -gt 1/,'only an engine the host was expected to run can raise a warning about it');
  assert.match(script,/num\(\)\{ awk /,'summary parsing must not be a pipeline: under pipefail a grep matching nothing aborted the run before any report was written, pinning the status at running:true forever');
  assert.doesNotMatch(script,/num\(\)\{ grep/);
});

/* The drawer used to print four numbers with no way to tell a host that was
   examined and found clean from one where nothing ran at all. */
test('the drawer never presents a metric from an engine that did not run',()=>{
  const ui=read('public/js/settings-pane.js'),css=read('public/css/08-settings-drawer.css'),palette=read('public/css/01-foundation.css');
  assert.match(ui,/clam\.available\?scanNum\(clam\.infected\):null/,'"Заражено: 0" from an engine that never started is the exact lie this release removes');
  assert.match(ui,/rkh\.available\?scanNum\(rkh\.possibleRootkits\):null/);
  assert.match(ui,/value===null\?'—':value/,'unknown must render as a dash, not as zero');
  assert.match(ui,/suspectFiles/,'rkhunter reports changed file properties and nothing surfaced them');
  assert.match(ui,/scan-engines/,'engine availability is the first thing an operator needs');
  assert.match(ui,/db\.present/,'ClamAV with an empty database scans nothing, so the card reports the signature files');
  assert.match(css,/\.scan-engines/);
  assert.match(palette,/--amber:#f59e0b/,'every var(--amber) on the dashboard resolved to nothing, so warn states rendered grey');
});

test('operators are given a way to install the missing engines',()=>{
  const lifecycle=read('bin/noxctl'),ui=read('public/js/settings-pane.js'),broker=read('bin/integration-config-broker.js');
  assert.match(lifecycle,/scan-setup\) cmd_scan_setup/,'the command must be dispatchable');
  assert.match(lifecycle,/ensure_scanner_packages \|\| die/,'updates never re-run install.sh, so the engines need their own entry point');
  assert.match(ui,/noxctl scan-setup/,'a disabled scan button must say how to enable it');
  assert.match(broker,/export function scannerEngines/);
  assert.doesNotMatch(broker,/installed:fs\.existsSync\('\/usr\/bin\/clamscan'\)/,'engine detection must not be pinned to a single directory');
});

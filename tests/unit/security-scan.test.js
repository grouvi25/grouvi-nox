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
  assert.match(script,/num\(\)\{ awk /,'summary parsing must not be a pipeline: under pipefail a grep matching nothing aborted the run before any report was written, pinning the status at running:true forever');
  assert.doesNotMatch(script,/num\(\)\{ grep/);
});

test('operators are given a way to install the missing engines',()=>{
  const lifecycle=read('bin/noxctl'),ui=read('public/js/settings-pane.js'),broker=read('bin/integration-config-broker.js');
  assert.match(lifecycle,/scan-setup\) cmd_scan_setup/,'the command must be dispatchable');
  assert.match(lifecycle,/ensure_scanner_packages \|\| die/,'updates never re-run install.sh, so the engines need their own entry point');
  assert.match(ui,/noxctl scan-setup/,'a disabled scan button must say how to enable it');
  assert.match(broker,/export function scannerEngines/);
  assert.doesNotMatch(broker,/installed:fs\.existsSync\('\/usr\/bin\/clamscan'\)/,'engine detection must not be pinned to a single directory');
});

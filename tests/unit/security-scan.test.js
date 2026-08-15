import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=file=>fs.readFileSync(new URL(`../../${file}`,import.meta.url),'utf8');
test('security scanner is isolated and bounded',()=>{const unit=read('deploy/vps-sentinel-security.service'),script=read('deploy/security-scan.sh');assert.match(unit,/CPUQuota=25%/);assert.match(unit,/MemoryMax=900M/);assert.match(unit,/IOSchedulingClass=idle/);assert.match(unit,/NoNewPrivileges=true/);assert.match(unit,/ProtectSystem=strict/);assert.match(unit,/KillMode=control-group/);assert.match(script,/flock -n/);assert.match(script,/exclude-dir=.*docker/)});
test('scanner API is authenticated, same-origin and brokered',()=>{const route=read('src/routes/api/security-scans.js'),client=read('src/integration-client.js'),broker=read('bin/integration-config-broker.js');assert.match(route,/requireSameOrigin/);assert.match(route,/actionLimit/);assert.match(client,/securityScanStatus/);assert.match(broker,/security-scan-policy\.json/)});

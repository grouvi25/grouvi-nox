import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=file=>fs.readFileSync(new URL(`../../${file}`,import.meta.url),'utf8');

/* Managed scanning shipped its unit, timer and policy to every updated host and
   its engines to none of them, because apt ran only from install.sh and an
   update swaps application files. These guard the convergence that closed it. */

test('host prerequisites have a single source of truth',()=>{
  const common=read('deploy/lib/common.sh'),install=read('deploy/install.sh'),lifecycle=read('bin/noxctl');
  assert.match(common,/SENTINEL_BASE_PACKAGES=\(/);
  assert.match(install,/apt-get install -y -qq "\$\{SENTINEL_BASE_PACKAGES\[@\]\}"/,'the installer must not carry its own copy of the package list');
  assert.doesNotMatch(install,/apt-get install -y -qq ca-certificates/,'the hardcoded list is what drifted from the update path');
  assert.match(lifecycle,/ensure_prerequisites \|\| warn/,'an update must converge host packages, and must not roll back a healthy app because apt hiccuped');
});

test('the ClamAV resource floor is identical everywhere it is enforced',()=>{
  const common=read('deploy/lib/common.sh'),script=read('deploy/security-scan.sh'),broker=read('bin/integration-config-broker.js');
  const memory={
    common:/SENTINEL_CLAMAV_MIN_TOTAL_MB=(\d+)/.exec(common)?.[1],
    script:/clam_min_mem_mb=(\d+)/.exec(script)?.[1],
    broker:/clamavMinMemoryMb=(\d+)/.exec(broker)?.[1],
  };
  const disk={
    common:/SENTINEL_CLAMAV_MIN_DISK_MB=(\d+)/.exec(common)?.[1],
    script:/clam_min_disk_mb=(\d+)/.exec(script)?.[1],
    broker:/clamavMinDiskMb=(\d+)/.exec(broker)?.[1],
  };
  assert.ok(Object.values(memory).every(Boolean),`each enforcement point must declare the memory floor: ${JSON.stringify(memory)}`);
  assert.ok(Object.values(disk).every(Boolean),`each enforcement point must declare the disk floor: ${JSON.stringify(disk)}`);
  assert.equal(new Set(Object.values(memory)).size,1,`memory floor drifted: ${JSON.stringify(memory)}`);
  assert.equal(new Set(Object.values(disk)).size,1,`disk floor drifted: ${JSON.stringify(disk)}`);
});

test('a host that cannot carry ClamAV is configured, not broken',()=>{
  const common=read('deploy/lib/common.sh'),script=read('deploy/security-scan.sh'),ui=read('public/js/settings-pane.js');
  assert.match(common,/scanner_expected_engines/);
  assert.match(script,/clam_expected=false/,'below the floor the engine is not expected, so the verdict must not be unavailable forever');
  assert.match(script,/\[\[ \$engines_complete == true \]\] \|\| result=unavailable/);
  assert.match(ui,/skipped/,'the drawer must distinguish "not installed" from "deliberately skipped"');
});

test('superseded installer defaults are migrated instead of pinned forever',()=>{
  const lifecycle=read('bin/noxctl'),example=read('.env.example'),install=read('deploy/install.sh');
  assert.match(lifecycle,/UPDATE_CHECK_INTERVAL_MS=1800000/,'an env written by an older installer wins over src/config.js, so shipping a better default is not enough');
  assert.match(lifecycle,/UPDATE_CHECK_INTERVAL_MS=600000/);
  assert.match(lifecycle,/UPDATE_FRESHNESS_MS=60000/);
  for (const [name,text] of [['.env.example',example],['install.sh',install]]) {
    assert.match(text,/UPDATE_CHECK_INTERVAL_MS=600000/,`${name} must ship the current default`);
    assert.doesNotMatch(text,/UPDATE_CHECK_INTERVAL_MS=1800000/,`${name} still writes the superseded value`);
  }
});

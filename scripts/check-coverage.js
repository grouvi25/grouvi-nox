#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const result=spawnSync(process.execPath,['--experimental-test-coverage','--test','tests/unit/*.test.js'],{encoding:'utf8',shell:true});
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');if(result.status!==0)process.exit(result.status||1);
const match=(result.stdout||'').match(/all files\s+\|\s+([0-9.]+)\s+\|\s+([0-9.]+)\s+\|\s+([0-9.]+)/);
if(!match){console.error('Coverage summary not found');process.exit(1)}
const [,lines,branches,functions]=match.map(Number);const floor={lines:50,functions:40};
console.log(`coverage gate: lines ${lines}% (>=${floor.lines}), functions ${functions}% (>=${floor.functions})`);
if(lines<floor.lines||functions<floor.functions)process.exit(1);

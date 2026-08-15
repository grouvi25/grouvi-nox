import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isStale } from '../../src/updates.js';
import { normalizeUpdateJob } from '../../bin/integration-config-broker.js';

/* Regression cover for v1.26.2, where a published release stayed invisible in the
   dashboard: the process checked GitHub once at boot, every install restarted the
   process, and the API served that one answer until the next background tick. */

test('update state is re-checked once it is older than the freshness window',()=>{const now=Date.now();assert.equal(isStale({checkedAt:null},60_000),true,'a process that has never checked must check before answering');assert.equal(isStale({checkedAt:now-5_000},60_000),false,'a recent answer is served from cache so reloads cannot burn the rate limit');assert.equal(isStale({checkedAt:now-61_000},60_000),true,'a release published after the last check must not stay hidden')});

test('a finished update job is reported only while it still describes the install',()=>{
  const now=Date.parse('2026-08-15T08:00:00Z'),idle={status:'idle',running:false};
  const shipped={status:'completed',running:false,ok:true,startedAt:1786286376163,finishedAt:1786286387000,version:'1.24.6',message:'Обновление установлено'};
  assert.deepEqual(normalizeUpdateJob({...shipped,finishedAt:now-5_000},{now,installed:'1.26.3'}),idle,'a job that installed another version must not label the drawer "Установлено"');
  assert.deepEqual(normalizeUpdateJob({...shipped,version:'1.26.3'},{now,installed:'1.26.3'}),idle,'a job older than its ttl must expire even when the version still matches');
  assert.equal(normalizeUpdateJob({...shipped,version:'1.26.3',finishedAt:now-5_000},{now,installed:'1.26.3'}).status,'completed','the install the operator just ran stays on screen');
  assert.equal(normalizeUpdateJob({status:'installing',running:true,startedAt:now-1_000},{now,installed:'1.26.3'}).running,true,'a running job is never expired underneath the progress bar');
  assert.deepEqual(normalizeUpdateJob(null,{now}),idle);
  assert.deepEqual(normalizeUpdateJob({},{now}),idle);
});

test('the update action stays reachable so a check can be forced by hand',()=>{const ui=fs.readFileSync('public/js/updates.js','utf8'),app=fs.readFileSync('public/app.js','utf8'),css=fs.readFileSync('public/style.css','utf8');assert.match(ui,/trigger\.hidden=false/,'the only entry point to the drawer must not be hidden by the state it reports');assert.doesNotMatch(ui,/\$\('updateOpen'\)\.hidden=!/,'availability drives the badge, not the existence of the button');assert.doesNotMatch(app,/\$\('updateOpen'\)\.hidden=true/,'switching to a fleet node must not remove the local update action');assert.match(ui,/trigger\.dataset\.state=/);assert.match(css,/\.update-trigger\[data-state="available"\]::after/);assert.doesNotMatch(css,/\.update-trigger:not\(\[hidden\]\)::after/)});

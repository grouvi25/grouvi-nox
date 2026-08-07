#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';
const roots=['src','bin','deploy','public','.env.example'];const forbidden=/(coursebot|mmo90|groovyhub|ijurist|myplanlife|coursebackup|\/opt\/reip)(?:\b|[-_/])/i,hits=[];
function scan(target){const stat=fs.statSync(target);if(stat.isDirectory()){for(const name of fs.readdirSync(target))scan(path.join(target,name));return}if(!/\.(js|sh|service|conf|html|css|example)$/.test(target)&&path.basename(target)!=='.env.example')return;const text=fs.readFileSync(target,'utf8');text.split('\n').forEach((line,index)=>{if(forbidden.test(line))hits.push(`${target}:${index+1}: ${line.trim()}`)})}
for(const root of roots)if(fs.existsSync(root))scan(root);if(hits.length){console.error('Customer-specific paths found:\n'+hits.join('\n'));process.exit(1)}console.log('hardcoded customer path audit: clean');

import fs from 'node:fs';
import { config } from './config.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
let state = {current:pkg.version,latest:pkg.version,available:false,checkedAt:null,releaseUrl:null,archiveUrl:null,checksumUrl:null,compareUrl:null,name:null,body:null,changes:[],publishedAt:null,error:null};

export function versionParts(version){return String(version||'').replace(/^v/,'').split(/[.-]/).slice(0,3).map(x=>Number(x)||0)}
export function isNewer(a,b){const av=versionParts(a),bv=versionParts(b);for(let i=0;i<3;i+=1){if(av[i]!==bv[i])return av[i]>bv[i]}return false}
export function updateState(){return{...state,changes:[...(state.changes||[])]}}
const githubHeaders=()=>({Accept:'application/vnd.github+json','User-Agent':`vps-sentinel/${pkg.version}`});
async function compareChanges(current,latest){
  const compareUrl=`https://github.com/${config.releaseRepo}/compare/v${current}...v${latest}`;
  try{const response=await fetch(`https://api.github.com/repos/${config.releaseRepo}/compare/v${current}...v${latest}`,{headers:githubHeaders(),signal:AbortSignal.timeout(10000)});if(!response.ok)return{compareUrl,changes:[]};const data=await response.json();return{compareUrl:data.html_url||compareUrl,changes:(data.commits||[]).map(commit=>String(commit.commit?.message||'').split('\n')[0].trim()).filter(Boolean).slice(-20).reverse()}}catch{return{compareUrl,changes:[]}}
}
export async function checkForUpdates(){
  const url=`https://api.github.com/repos/${config.releaseRepo}/releases/latest`;
  try{
    const response=await fetch(url,{headers:githubHeaders(),signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error(`GitHub HTTP ${response.status}`);
    const release=await response.json(),latest=String(release.tag_name||'').replace(/^v/,''),assets=Array.isArray(release.assets)?release.assets:[],archive=assets.find(a=>/vps-sentinel-v.*-linux\.tar\.gz$/.test(a.name)),sums=assets.find(a=>a.name==='SHA256SUMS'),available=Boolean(latest&&isNewer(latest,pkg.version));
    const details=available?await compareChanges(pkg.version,latest):{compareUrl:null,changes:[]};
    state={current:pkg.version,latest:latest||pkg.version,available,checkedAt:Date.now(),releaseUrl:release.html_url||null,archiveUrl:archive?.browser_download_url||null,checksumUrl:sums?.browser_download_url||null,compareUrl:details.compareUrl,name:release.name||null,body:String(release.body||'').slice(0,30000),changes:details.changes,publishedAt:release.published_at||null,error:null};
  }catch(error){state={...state,checkedAt:Date.now(),error:error.message}}
  return updateState();
}
export function startUpdateChecks(){checkForUpdates();setInterval(checkForUpdates,config.updateCheckIntervalMs).unref()}

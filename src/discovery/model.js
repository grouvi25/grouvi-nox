import crypto from 'node:crypto';
export const DISCOVERY_SCHEMA=1;
export const TYPES=new Set(['project','service','container','runtime','domain','backup','database','filesystem','capability']);
export function stableId(type,key){return `${type}:${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0,16)}`}
export function candidate({type,key,name,path=null,source,confidence=0.5,reasons=[],meta={},defaultEnabled=true}){
  if(!TYPES.has(type))throw new Error(`unsupported discovery type ${type}`);
  return{id:stableId(type,key),type,name:String(name||key).slice(0,160),path,source,confidence:Math.max(0,Math.min(1,Number(confidence)||0)),reasons:[...new Set(reasons)].slice(0,8),meta,defaultEnabled:Boolean(defaultEnabled)};
}
export function mergeCandidates(items){const map=new Map();for(const item of items){const existing=map.get(item.id);if(!existing||item.confidence>existing.confidence)map.set(item.id,existing?{...existing,...item,reasons:[...new Set([...existing.reasons,...item.reasons])]}:item)}return[...map.values()].sort((a,b)=>a.type.localeCompare(b.type)||b.confidence-a.confidence||a.name.localeCompare(b.name))}

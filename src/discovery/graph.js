import path from 'node:path';

const cleanPath=value=>{if(!value||typeof value!=='string'||!value.startsWith('/'))return null;return path.posix.normalize(value)};
const within=(child,parent)=>Boolean(child&&parent&&(child===parent||child.startsWith(`${parent}/`)));
const runtimeAdapter=item=>item.type==='container'?'container':item.type==='service'&&item.source==='pm2'?'pm2':item.type==='service'&&item.source==='systemd'?'systemd':null;

function relationScore(item,project){
  const projectPath=cleanPath(project.path||project.meta?.workingDir), itemPath=cleanPath(item.path), cwd=cleanPath(item.meta?.cwd||item.meta?.workingDirectory||item.meta?.workingDir||item.meta?.projectPath);
  const compose=String(project.meta?.composeProject||project.name).toLowerCase(), itemCompose=String(item.meta?.project||item.meta?.composeProject||'').toLowerCase();
  let score=0,reason=null;
  if(projectPath&&cwd&&(within(cwd,projectPath)||within(projectPath,cwd))){score=100;reason='working directory'}
  else if(projectPath&&itemPath&&within(itemPath,projectPath)){score=90;reason='project path'}
  else if(itemCompose&&compose&&itemCompose===compose){score=85;reason='Compose project'}
  else if(projectPath&&item.meta?.configPath&&within(cleanPath(item.meta.configPath),projectPath)){score=75;reason='configuration path'}
  return{score,reason};
}

export function buildProjectGraph(discovery){
  const items=discovery.items||[],projects=items.filter(item=>item.type==='project'&&item.enabled).map(project=>({...project,components:[],relations:[]}));
  const assigned=new Set();
  for(const item of items){
    if(item.type==='project'||!item.enabled)continue;
    let best=null;
    for(const project of projects){const relation=relationScore(item,project);if(relation.score&&(!best||relation.score>best.score))best={project,...relation}}
    if(!best)continue;
    best.project.components.push({...item,adapter:runtimeAdapter(item),relation:best.reason});assigned.add(item.id);
  }
  for(const project of projects){
    project.components.sort((a,b)=>Boolean(b.adapter)-Boolean(a.adapter)||a.type.localeCompare(b.type)||a.name.localeCompare(b.name));
    const adapters=project.components.filter(x=>x.adapter),running=adapters.filter(x=>!/stopped|failed|dead|exited|offline/i.test(String(x.meta?.status||''))).length;
    project.health={runtimeCount:adapters.length,running,attention:Math.max(0,adapters.length-running),componentCount:project.components.length};
    project.stack=[...new Set(project.components.map(x=>x.adapter||x.type).filter(Boolean))];
  }
  projects.sort((a,b)=>b.health.runtimeCount-a.health.runtimeCount||b.components.length-a.components.length||a.name.localeCompare(b.name));
  const unassigned=items.filter(item=>item.enabled&&item.type!=='project'&&!assigned.has(item.id));
  return{generatedAt:discovery.generatedAt,projects,unassigned,summary:{projects:projects.length,linked:assigned.size,unassigned:unassigned.length,runtimes:projects.reduce((n,p)=>n+p.health.runtimeCount,0)}};
}

export function findProject(discovery,id){return buildProjectGraph(discovery).projects.find(project=>project.id===id)||null}
import { $, esc } from './utils.js';
const labels={project:'Проект',service:'Сервис',container:'Контейнер',domain:'Домен',backup:'Бэкап',database:'База',runtime:'Runtime',capability:'Возможность'};
const stackLabel=value=>({container:'Docker',pm2:'PM2',systemd:'systemd',domain:'nginx',database:'DB',backup:'backup'}[value]||value);
export function createDiscoveryController({api,openProject,openTarget}){
  let data={items:[],summary:{}},graph={projects:[],unassigned:[],summary:{}},bound=false;
  const projectRow=project=>`<article class="project-workspace"><button class="project-row" type="button" data-project-id="${esc(project.id)}"><span class="project-state ${project.health.attention?'warn':'ok'}"></span><span class="project-main"><b>${esc(project.name)}</b><small>${esc(project.path||project.source)}</small></span><span class="project-stack">${project.stack.length?project.stack.map(x=>`<i>${esc(stackLabel(x))}</i>`).join(''):'<i>metadata</i>'}</span><span class="project-health"><b>${project.health.runtimeCount}</b><small>runtime</small></span><svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg></button></article>`;
  const targetRow=item=>`<button class="target-row" type="button" ${item.adapter?`data-service-type="${esc(item.adapter)}" data-service-name="${esc(item.name)}"`:''}><span>${esc(labels[item.type]||item.type)}</span><b>${esc(item.name)}</b><small>${esc(item.path||item.source)}</small>${item.adapter?'<i>логи</i>':''}</button>`;
  function render(){
    const q=$('inventorySearch')?.value.trim().toLowerCase()||'',stack=$('inventoryType')?.value||'all';
    const projects=graph.projects.filter(project=>(stack==='all'||project.stack.includes(stack))&&(!q||`${project.name} ${project.path||''} ${project.stack.join(' ')}`.toLowerCase().includes(q)));
    $('projectList').innerHTML=projects.length?projects.map(projectRow).join(''):'<div class="empty">Проекты по этому фильтру не найдены.</div>';
    const loose=graph.unassigned.filter(item=>!q||`${item.name} ${item.path||''} ${item.source}`.toLowerCase().includes(q));
    $('unassignedCount').textContent=loose.length;$('unassignedList').innerHTML=loose.length?loose.map(targetRow).join(''):'<div class="empty">Все включённые цели привязаны к проектам.</div>';
  }
  function bind(){if(bound)return;bound=true;for(const id of ['inventorySearch','inventoryType'])$(id)?.addEventListener('input',render);$('projectList')?.addEventListener('click',event=>{const row=event.target.closest('[data-project-id]');if(row)openProject(row.dataset.projectId)});}
  async function load(){try{
    [data,graph]=await Promise.all([api('/api/discovery'),api('/api/projects')]);
    $('discoveryCount').textContent=graph.projects.length;$('nbDiscovery').textContent=graph.projects.length;
    $('discoverySummary').innerHTML=`<div><span>Проекты</span><b>${graph.summary.projects||0}</b></div><div><span>Связанные цели</span><b>${graph.summary.linked||0}</b></div><div><span>Runtime</span><b>${graph.summary.runtimes||0}</b></div><div><span>Без проекта</span><b>${graph.summary.unassigned||0}</b></div>`;
    const stacks=[...new Set(graph.projects.flatMap(project=>project.stack))];$('inventoryType').innerHTML='<option value="all">Любой стек</option>'+stacks.map(value=>`<option value="${esc(value)}">${esc(stackLabel(value))}</option>`).join('');render();bind();
  }catch(error){$('projectList').innerHTML=`<div class="empty">Discovery недоступен: ${esc(error.message)}</div>`}}
  return{load};
}
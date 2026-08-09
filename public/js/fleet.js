import{$,esc}from'./utils.js';

export function createFleetController({onSelect}={}){
  let selected='local',role='standalone',nodes=[],hubName='';
  const list=()=>$('fleetList');
  function render(){
    const box=list();if(!box)return;
    const show=nodes.length>0;
    $('fleetSection').hidden=!show;
    if(!show){box.innerHTML='';return}
    hubName=hubName||$('sideHost')?.textContent||'Hub';
    box.innerHTML=`<button class="fleet-node ${selected==='local'?'active':''}" type="button" data-fleet-node="local"><span class="fleet-status online"></span><span><b>${esc(hubName)}</b><em>Hub, этот VPS</em></span><small>local</small></button>`+nodes.map(n=>`<button class="fleet-node ${selected===n.id?'active':''}" type="button" data-fleet-node="${esc(n.id)}" title="CPU ${n.cpu.toFixed(1)}%, RAM ${n.memory.toFixed(1)}%, диск ${n.disk.toFixed(1)}%"><span class="fleet-status ${!n.online||n.critical?'offline':n.alerts?'warning':'online'}"></span><span><b>${esc(n.name)}</b><em>${n.online?'Данные поступают':'Нет связи'}</em></span><small>${n.update?.available?'update':`v${esc(n.version||'?')}`}</small></button>`).join('');
  }
  async function load(){
    try{const response=await fetch('/api/fleet/nodes',{credentials:'same-origin'});if(!response.ok)return;const data=await response.json();role=data.role||'standalone';nodes=data.nodes||[];if(selected!=='local'&&!nodes.some(n=>n.id===selected))selected='local';render()}catch{}
  }
  function bind(){list()?.addEventListener('click',event=>{const button=event.target.closest('[data-fleet-node]');if(!button||button.dataset.fleetNode===selected)return;selected=button.dataset.fleetNode;render();onSelect?.(selected)})}
  function update(){if(role==='hub')render()}
  function current(){return selected}
  return{load,bind,update,current}
}

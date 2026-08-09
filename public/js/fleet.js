import{$,esc}from'./utils.js';

export function createFleetController({onSelect}={}){
  let selected='local',nodes=[],signature='';
  function render(){
    const picker=$('fleetPicker'),select=$('fleetSelect');if(!picker||!select)return;
    picker.hidden=!nodes.length;
    if(!nodes.length)return;
    const hub=$('sideHost')?.textContent||'Hub';
    const nextSignature=JSON.stringify([hub,...nodes.map(n=>[n.id,n.name,n.online,n.version,n.alerts])]);
    if(nextSignature===signature){select.value=selected;return}
    signature=nextSignature;
    select.innerHTML=`<option value="local">${esc(hub)} · Hub</option>`+nodes.map(n=>`<option value="${esc(n.id)}">${esc(n.name)} · ${n.online?'online':'offline'} · v${esc(n.version||'?')}</option>`).join('');
    select.value=selected;
  }
  async function load(){
    try{const response=await fetch('/api/fleet/nodes',{credentials:'same-origin'});if(!response.ok)return;const data=await response.json();nodes=data.nodes||[];if(selected!=='local'&&!nodes.some(n=>n.id===selected))selected='local';render()}catch{}
  }
  function bind(){$('fleetSelect')?.addEventListener('change',event=>{selected=event.target.value;onSelect?.(selected)})}
  function update(){render()}
  function current(){return selected}
  return{load,bind,update,current}
}

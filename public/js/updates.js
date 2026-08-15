import{$,esc}from'./utils.js';

const STAGES={
  queued:{label:'Обновление поставлено в очередь',progress:6},
  downloading:{label:'Скачиваю релиз с GitHub',progress:18},
  verifying:{label:'Проверяю SHA-256 и состав архива',progress:34},
  backup:{label:'Создаю резервную копию',progress:48},
  installing:{label:'Устанавливаю новую версию',progress:66},
  restarting:{label:'Перезапускаю Grouvi Nox',progress:82},
  healthcheck:{label:'Проверяю сервисы и подключение',progress:94},
  completed:{label:'Обновление установлено',progress:100},
  rollback:{label:'Проверка не пройдена, возвращаю прошлую версию',progress:74},
  failed:{label:'Обновление не установлено',progress:100},
};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const cleanSubject=value=>String(value||'').replace(/^[-*]\s*/,'').replace(/\s*\(#\d+\)$/,'').trim();
const checkedAt=state=>state.checkedAt?`Проверено в ${new Date(state.checkedAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}`:'';
function changelog(release){
  const changes=(release.changes||[]).map(cleanSubject).filter(Boolean).slice(0,12);
  if(changes.length)return `<ul>${changes.map(item=>`<li>${esc(item)}</li>`).join('')}</ul>${release.compareUrl?`<a class="update-compare" href="${esc(release.compareUrl)}" target="_blank" rel="noopener">Все изменения на GitHub</a>`:''}`;
  const lines=String(release.body||'').split('\n').map(x=>x.trim()).filter(Boolean).filter(x=>!/^#{1,6}\s*Что изменилось$/i.test(x)&&!/Full Changelog/i.test(x)&&!/^\*\*.*compare\/v?\d/i.test(x));
  const useful=lines.filter(x=>!/^https?:\/\//i.test(x)).map(cleanSubject).filter(Boolean).slice(0,12);
  return useful.length?`<ul>${useful.map(item=>`<li>${esc(item.replace(/\*\*/g,''))}</li>`).join('')}</ul>`:`<p>Технический релиз: исправления надёжности и интерфейса.</p>${release.compareUrl?`<a class="update-compare" href="${esc(release.compareUrl)}" target="_blank" rel="noopener">Посмотреть изменения на GitHub</a>`:''}`;
}
export function createUpdateController({api,setWorkspacePane}){
  let state=null,timer=null,installing=false,misses=0;
  const release=()=>state?.release||state||{};
  function renderRelease(){const u=release(),available=Boolean(u.available),failed=Boolean(u.error),trigger=$('updateOpen');trigger.hidden=false;trigger.dataset.state=failed?'failed':available?'available':'current';trigger.title=failed?'Не удалось проверить обновления':available?`Доступно обновление v${u.latest||'?'}`:'Обновления';$('updateTopVersion').textContent=available?`v${u.latest||'?'}`:'';$('updateCurrentVersion').textContent=`v${u.current||'?'}`;$('updateLatestVersion').textContent=failed?'ошибка':`v${available?(u.latest||'?'):(u.current||'?')}`;$('updatePaneVersion').textContent=failed?'ошибка':available?'доступно':'актуально';$('updatePaneVersion').className=`pill ${failed?'crit':available?'warn':'ok'}`;$('updatePublishedAt').textContent=failed?`Проверка не удалась: ${esc(u.error)}`:[available&&u.publishedAt?`Опубликовано ${new Date(u.publishedAt).toLocaleString('ru-RU')}`:'',checkedAt(u)].filter(Boolean).join(' · ');$('updateChangelog').innerHTML=failed?`<p class="update-error">Не удалось получить состояние обновлений. Откройте панель ещё раз для повторной проверки.</p>`:available?changelog(u):`<p>Установлена последняя версия v${esc(u.current||'?')}.</p>`;$('updateInstall').disabled=!available||installing||Boolean(state?.job?.running)}
  function renderJob(job={}){const stage=STAGES[job.status]||{label:job.status||'Подготовка',progress:10},active=Boolean(job.running)||['completed','failed','rollback'].includes(job.status);$('updateProgress').hidden=!active;$('updateProgress').className=`update-progress ${job.ok?'success':''} ${job.status==='failed'?'error':''}`;$('updateProgressText').textContent=job.message||stage.label;$('updateProgressMeta').textContent=job.running?'Не закрывайте вкладку, переподключение произойдёт автоматически':job.ok?`Готово${job.version?` · v${job.version}`:''}`:job.status==='rollback'?'Прошлая версия восстановлена':job.status==='failed'?'Система продолжает работать на текущей версии':'';$('updateProgressBar').style.width=`${stage.progress}%`;$('updateInstall').disabled=Boolean(job.running)||!release().available;$('updateInstall').textContent=job.running?'Обновляю…':job.ok?'Установлено':'Обновить';$('updateCancel').textContent=job.running?'Скрыть':'Отмена'}
  async function load(){try{state=await api('/api/update');misses=0}catch(error){state={release:{current:'?',available:false,error:error.message},job:{status:'unavailable',running:false}}}renderRelease();renderJob(state.job);return state}
  async function open(){setWorkspacePane('updatePane');try{await load()}catch(error){$('updateProgress').hidden=false;$('updateProgressText').textContent=`Не удалось проверить обновление: ${error.message}`}}
  function close(){if(!installing){clearInterval(timer);timer=null}setWorkspacePane()}
  async function pollUntilReady(){for(let attempt=0;attempt<120;attempt+=1){await sleep(attempt<8?1500:2500);try{const next=await load();installing=Boolean(next.job?.running);if(!installing){if(next.job?.ok){renderJob(next.job);setTimeout(()=>location.reload(),1400)}return}}catch{misses+=1;installing=true;$('updateProgress').hidden=false;$('updateProgressText').textContent=misses<3?'Grouvi Nox перезапускается…':'Жду возвращения Grouvi Nox…';$('updateProgressMeta').textContent='Соединение восстановится автоматически';$('updateProgressBar').style.width='88%'}}installing=false;renderJob({status:'failed',message:'Grouvi Nox не вернулся вовремя. Проверьте журнал сервиса.'})}
  async function install(){if(!release().available||installing)return;installing=true;renderJob({status:'queued',running:true,message:'Запускаю безопасное обновление…'});try{const result=await api('/api/update/install',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});renderJob(result.job);await pollUntilReady()}catch(error){installing=false;renderJob({status:'failed',running:false,message:`Не удалось запустить обновление: ${error.message}`})}}
  return{load,open,close,install}
}

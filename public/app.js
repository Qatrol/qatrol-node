'use strict';
const API='/api';
const S={me:null,expPage:0,expPageSize:15,charts:{},chartsInited:false};

async function api(path,opts={}){
  try{
    const token=sessionStorage.getItem('koin_session');
    const headers={'Content-Type':'application/json'};
    if(token)headers['X-Session-Token']=token;
    const r=await fetch(API+path,{headers,credentials:'include',...opts});
    if(r.status===401){window.location.href='/';return{error:'unauthorized'}}
    return await r.json();
  }catch{return{error:'network',offline:true}}
}

let _tt;
function toast(msg,type='ok'){const t=document.getElementById('toast');t.textContent=msg;t.className='toast '+type+' show';clearTimeout(_tt);_tt=setTimeout(()=>t.className='toast',3500)}
function copyText(text){navigator.clipboard.writeText(String(text).trim()).then(()=>toast('Скопировано!','info'))}
function timeAgo(ts){const s=Math.floor((Date.now()-ts)/1000);if(s<5)return'только что';if(s<60)return s+'с';if(s<3600)return Math.floor(s/60)+'м';if(s<86400)return Math.floor(s/3600)+'ч';return new Date(ts).toLocaleDateString('ru')}
function fmtTime(ts){return new Date(ts).toLocaleString('ru')}
function short(addr,n=8){if(!addr||addr.length<=n*2+3)return addr;return addr.slice(0,n)+'…'+addr.slice(-n)}
function setText(id,val){const e=document.getElementById(id);if(e)e.textContent=val}
function makeQR(el,text,size=120){if(!el||!text||!window.QRCode)return;el.innerHTML='';new QRCode(el,{text,width:size,height:size,colorDark:'#000',colorLight:'#fff',correctLevel:QRCode.CorrectLevel.M})}

function nav(page){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('page-'+page)?.classList.add('active');
  document.querySelectorAll('.nav-item[data-page="'+page+'"]').forEach(n=>n.classList.add('active'));
  if(page==='wallet')loadWallet();
  if(page==='receive')loadReceive();
  if(page==='explorer')loadExplorer();
  if(page==='mempool')loadMempool();
  if(page==='send')prefillSend();
  if(page==='stats'){initCharts();loadStats();}
  if(page==='mining')loadMining();
  closeSidebar();
}
document.querySelectorAll('.nav-item').forEach(n=>n.addEventListener('click',e=>{e.preventDefault();nav(n.dataset.page)}));

function toggleSidebar(){
  const s=document.getElementById('sidebar'),o=document.getElementById('sidebar-overlay');
  s.classList.toggle('open');o.classList.toggle('open');
}
function closeSidebar(){
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('open');
}

async function loadDashboard(){
  const[stats,chain]=await Promise.all([api('/stats'),api('/chain?limit=8')]);
  if(stats.offline||stats.error){setNodeStatus(false);return stats;}
  setNodeStatus(true);
  setText('s-blocks',stats.blocks);setText('s-diff',stats.difficulty);setText('s-pend',stats.pendingTx);
  setText('s-hash',stats.hashrate>0?(stats.hashrate/1000).toFixed(1)+' kH/s':'—');
  setText('s-fee',(stats.feePercent||0.1)+'%');setText('s-valid',stats.valid?'✓ Да':'✗ Нет');
  setText('s-circ',Number(stats.circulatingSupply||0).toLocaleString('ru'));
  setText('s-uptime',Math.floor((stats.uptime||0)/60)+' мин');
  const el=document.getElementById('d-blocks');
  if(!chain.chain?.length){el.innerHTML='<div class="empty">Блоков нет — запусти майнер</div>';}
  else{el.innerHTML=chain.chain.map(renderBlock).join('');}
  return stats;
}

function setNodeStatus(on){
  document.getElementById('nodeDot').className=on?'dot-live':'dot-dead';
  document.getElementById('nodeText').textContent=on?'нода активна':'нода offline';
}

// Charts — fixed height wrapper approach
const liveData={labels:[],hashrate:[],diff:[]};

function mkChart(id,color,yLbl){
  const ctx=document.getElementById(id);
  if(!ctx)return null;
  return new Chart(ctx,{
    type:'line',
    data:{labels:[],datasets:[{data:[],borderColor:color,backgroundColor:color.replace('rgb','rgba').replace(')',',0.08)'),borderWidth:1.5,pointRadius:0,fill:true,tension:0.3}]},
    options:{responsive:true,maintainAspectRatio:false,animation:false,
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>c.parsed.y.toFixed(2)+' '+yLbl}}},
      scales:{x:{display:false},y:{display:true,grid:{color:'rgba(100,95,200,.07)'},ticks:{color:'#545778',font:{size:10},maxTicksLimit:4}}}}
  });
}

function initCharts(){
  if(S.chartsInited)return;
  S.chartsInited=true;
  S.charts.hashrate =mkChart('chart-hashrate', 'rgb(120,111,255)','kH/s');
  S.charts.blocktime=mkChart('chart-blocktime','rgb(82,184,232)', 'сек');
  S.charts.txcount  =mkChart('chart-txcount',  'rgb(244,194,74)', 'тр.');
  S.charts.diff     =mkChart('chart-diff',     'rgb(60,214,140)', 'diff');
}

function pushChart(c,labels,data){if(!c)return;c.data.labels=labels;c.data.datasets[0].data=data;c.update('none');}

function updateLiveCharts(stats){
  const t=new Date().toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  liveData.labels.push(t);liveData.hashrate.push(+((stats.hashrate||0)/1000).toFixed(2));liveData.diff.push(stats.difficulty||0);
  if(liveData.labels.length>40){liveData.labels.shift();liveData.hashrate.shift();liveData.diff.shift();}
  pushChart(S.charts.hashrate,[...liveData.labels],[...liveData.hashrate]);
  pushChart(S.charts.diff,[...liveData.labels],[...liveData.diff]);
}

async function loadStats(){
  const[stats,cd]=await Promise.all([api('/stats'),api('/chartdata')]);
  if(!stats.error)updateLiveCharts(stats);
  if(cd.data?.length){
    const d=cd.data.slice(-40);
    pushChart(S.charts.blocktime,d.map(b=>'#'+b.index),d.map(b=>+(b.blockTime||0).toFixed(1)));
    pushChart(S.charts.txcount,  d.map(b=>'#'+b.index),d.map(b=>b.txCount||0));
  }
  if(!stats.error){
    const circ=parseFloat(stats.circulatingSupply||0);
    const pct=Math.min(100,(circ/1e9)*100).toFixed(2);
    const bar=document.getElementById('supply-bar');if(bar)bar.style.width=pct+'%';
    setText('stat-circ',circ.toLocaleString('ru'));setText('stat-pct',pct+'%');
    if(stats.genesisAddress){const gen=await api('/balance/'+stats.genesisAddress);setText('stat-genesis',(gen.balance||0).toLocaleString('ru'));}
  }
}

function renderBlock(b){
  const fee=b.transactions?.find(t=>t.from==='SYSTEM_FEE');
  return`<div class="block-item" onclick="openBlock('${b.hash}')">
    <div class="block-top"><div class="block-num">#${b.index}</div><div class="block-age">${timeAgo(b.timestamp)}</div></div>
    <div class="block-hash">⛓ ${b.hash}</div>
    <div class="block-meta"><span><span class="badge">${b.transactions?.length||0} тр.</span></span><span>diff:${b.difficulty}</span><span>nonce:${(b.nonce||0).toLocaleString()}</span>${fee?`<span>💰+${fee.amount}→${short(fee.to,6)}</span>`:''}</div>
  </div>`;
}

function renderTxItem(tx,myAddr){
  const isIn=tx.to===myAddr,isSys=tx.from==='SYSTEM'||tx.from==='SYSTEM_FEE',isPend=!tx.confirmed;
  const dc=isPend?'pend':(isIn?'in':'out'),dl=isPend?'⧖ Ожидает':(isIn?'↙ Получено':'↗ Отправлено');
  const peer=isIn?(isSys?'⛏ Сеть':short(tx.from)):short(tx.to);
  return`<div class="tx-item" onclick="openTx('${tx.id}')">
    <div><div class="tx-dir ${dc}">${dl}</div><div class="tx-peer">${peer}</div>${tx.memo?`<div class="tx-memo">${tx.memo}</div>`:''}</div>
    <div class="tx-right"><div class="tx-amount ${isPend?'':(isIn?'in':'out')}">${isIn?'+':'-'}${tx.amount} QTR</div>${tx.fee>0?`<div class="tx-meta">fee:${tx.fee}</div>`:''}<div class="tx-meta">${timeAgo(tx.timestamp)}</div></div>
  </div>`;
}

async function loadWallet(){
  if(!S.me)return;
  const addr=S.me.address;
  setText('w-label',S.me.label||'Кошелёк');setText('w-addr',addr);
  document.getElementById('w-addr').onclick=()=>copyText(addr);
  setText('w-balance','...');
  makeQR(document.getElementById('w-qr'),addr,90);
  const[bal,hist]=await Promise.all([api('/balance/'+addr),api('/history/'+addr+'?limit=50')]);
  if(!bal.error){setText('w-balance',(bal.balance||0).toFixed(6));setText('w-pending',(bal.pendingOut||0).toFixed(6));}
  const hEl=document.getElementById('w-history');
  hEl.innerHTML=hist.history?.length?hist.history.map(t=>renderTxItem(t,addr)).join(''):'<div class="empty">Транзакций нет</div>';
}

function loadReceive(){
  const addr=S.me?.address||'';
  makeQR(document.getElementById('recv-qr'),addr,200);
  document.getElementById('recv-addr').childNodes[0].textContent=addr;
}

function prefillSend(){if(S.me)document.getElementById('s-from').value=S.me.address;}

function updateFee(){
  const amt=parseFloat(document.getElementById('s-amount').value)||0;
  const fee=amt>0?Math.max(0.0001,parseFloat((amt*0.001).toFixed(6))):0;
  document.getElementById('s-fee').value=amt>0?fee:'';
  document.getElementById('s-total').textContent=amt>0?(amt+fee).toFixed(6):'0';
}

async function doSend(){
  const to=document.getElementById('s-to').value.trim();
  const amount=parseFloat(document.getElementById('s-amount').value);
  const memo=document.getElementById('s-memo').value.trim();
  const password=document.getElementById('s-pass').value;
  if(!to){toast('Введите адрес получателя','err');return;}
  if(!amount||amount<=0){toast('Введите сумму','err');return;}
  if(!password){toast('Введите пароль для подписи','err');return;}
  const res=await api('/send',{method:'POST',body:JSON.stringify({to,amount,memo,password})});
  if(res.error){toast(res.error,'err');return;}
  toast('✓ Отправлено! Комиссия: '+res.fee+' QTR','ok');
  ['s-to','s-amount','s-memo','s-pass','s-fee'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('s-total').textContent='0';
}

async function doLogout(){
  await api('/auth/logout',{method:'POST',body:'{}'});
  document.cookie='koin_session=;path=/;max-age=0';
  sessionStorage.removeItem('koin_session');
  window.location.href='/';
}

async function loadExplorer(){
  const el=document.getElementById('exp-list');
  el.innerHTML='<div class="empty">Загрузка...</div>';
  const offset=S.expPage*S.expPageSize;
  const data=await api('/chain?limit='+S.expPageSize+'&offset='+offset);
  if(!data.chain){el.innerHTML='<div class="empty">Нода недоступна</div>';return;}
  el.innerHTML=data.chain.length?data.chain.map(renderBlock).join(''):'<div class="empty">Блоков нет</div>';
  const pages=Math.ceil((data.total||0)/S.expPageSize);
  const pager=document.getElementById('exp-pager');
  if(pages<=1){pager.innerHTML='';return;}
  let html='';
  for(let i=0;i<pages;i++){
    if(i===0||i===pages-1||Math.abs(i-S.expPage)<=2)html+='<button class="pager-btn '+(i===S.expPage?'active':'')+'" onclick="goPage('+i+')">'+(i+1)+'</button>';
    else if(Math.abs(i-S.expPage)===3)html+='<span style="color:var(--muted)">…</span>';
  }
  pager.innerHTML=html;
}
function goPage(n){S.expPage=n;loadExplorer();}

async function doSearch(){
  const q=document.getElementById('exp-search').value.trim();
  if(!q)return;
  const res=await api('/search/'+encodeURIComponent(q));
  if(res.error){toast('Не найдено','err');return;}
  if(res.type==='block')openBlock(res.data.hash);
  if(res.type==='tx')openTx(res.data.id);
  if(res.type==='address')openAddr(res.data.address);
}

async function loadMempool(){
  const data=await api('/mempool');
  setText('mp-cnt',data.count||0);setText('mp-fees',(data.totalFees||0).toFixed(6));
  const el=document.getElementById('mp-list');
  if(!data.mempool?.length){el.innerHTML='<div class="empty">Очередь пуста</div>';return;}
  el.innerHTML=data.mempool.map(tx=>'<div class="tx-item" onclick="openTx(\''+tx.id+'\')'+'"><div><div class="tx-dir pend">⧖ В очереди</div><div class="tx-peer">'+short(tx.from)+' → '+short(tx.to)+'</div>'+(tx.memo?'<div class="tx-memo">'+tx.memo+'</div>':'')+'</div><div class="tx-right"><div class="tx-amount" style="color:var(--accent2)">'+tx.amount+' QTR</div><div class="tx-meta">fee:'+tx.fee+' · '+timeAgo(tx.timestamp)+'</div></div></div>').join('');
}

function openModal(type,data){document.getElementById('modal').classList.add('open');document.getElementById('modal-body').innerHTML=buildModal(type,data);}
function closeModal(){document.getElementById('modal').classList.remove('open');}

function buildModal(type,data){
  const X='<button class="modal-close" onclick="closeModal()">✕</button>';
  if(type==='scanQR')return'<div class="modal-title">Вставить адрес '+X+'</div><div class="field"><input class="input" id="qr-paste" placeholder="K..." autofocus></div><button class="btn btn-primary btn-full" onclick="pasteQR()">Применить</button>';
  if(type==='mnemonic')return'<div class="modal-title">Мнемоник '+X+'</div><div class="warn-box" style="margin-bottom:14px">⚠ Никому не показывай.</div><div class="field"><label class="label">Пароль</label><input class="input" type="password" id="mn-pass" placeholder="Ваш пароль"></div><button class="btn btn-primary btn-full" onclick="showMnemonic()">Показать</button><div id="mn-result" style="margin-top:14px"></div>';
  if(type==='block')return renderBlockModal(data);
  if(type==='tx')return renderTxModal(data);
  if(type==='addr')return'<div class="modal-title">Адрес '+X+'</div><div class="empty">Загрузка...</div>';
  return'';
}

function renderBlockModal(d){
  const b=d.block||d,conf=d.confirmations||0;
  const txRows=(b.transactions||[]).map(tx=>'<div class="tx-item" onclick="openTx(\''+tx.id+'\')'+'"><div><div class="tx-peer">'+short(tx.from)+' → '+short(tx.to)+'</div>'+(tx.memo?'<div class="tx-memo">'+tx.memo+'</div>':'')+'</div><div class="tx-right"><div class="tx-amount" style="color:var(--accent2)">'+tx.amount+' QTR</div>'+(tx.fee>0?'<div class="tx-meta">fee:'+tx.fee+'</div>':'')+'</div></div>').join('');
  return'<div class="modal-title">Блок #'+b.index+' <button class="modal-close" onclick="closeModal()">✕</button></div>'+
    '<div class="detail-row"><div class="detail-key">Hash</div><div class="detail-val" style="color:var(--accent);cursor:pointer" onclick="copyText(\''+b.hash+'\')">'+b.hash+'</div></div>'+
    '<div class="detail-row"><div class="detail-key">PrevHash</div><div class="detail-val" style="font-size:11px">'+b.prevHash+'</div></div>'+
    '<div class="detail-row"><div class="detail-key">Время</div><div class="detail-val">'+fmtTime(b.timestamp)+'</div></div>'+
    '<div class="detail-row"><div class="detail-key">Nonce</div><div class="detail-val">'+(b.nonce||0).toLocaleString()+'</div></div>'+
    '<div class="detail-row"><div class="detail-key">Сложность</div><div class="detail-val">'+b.difficulty+'</div></div>'+
    '<div class="detail-row"><div class="detail-key">Майнер</div><div class="detail-val" style="cursor:pointer" onclick="openAddr(\''+b.miner+'\')">'+short(b.miner,14)+'</div></div>'+
    '<div class="detail-row"><div class="detail-key">Подтверждений</div><div class="detail-val"><span class="badge green">'+conf+'</span></div></div>'+
    '<div style="margin-top:16px"><div class="label" style="margin-bottom:10px">Транзакции ('+(b.transactions?.length||0)+')</div><div class="tx-list">'+(txRows||'<div class="empty">Нет</div>')+'</div></div>';
}

function renderTxModal(d){
  const tx=d.tx||d,conf=d.confirmations;
  const signed=tx.signature&&tx.signature.length>20&&tx.signature!=='GENESIS'&&tx.signature!=='SYSTEM_FEE';
  return'<div class="modal-title">Транзакция <button class="modal-close" onclick="closeModal()">✕</button></div>'+
    '<div class="detail-row"><div class="detail-key">ID</div><div class="detail-val" style="cursor:pointer" onclick="copyText(\''+tx.id+'\')">'+tx.id+'</div></div>'+
    '<div class="detail-row"><div class="detail-key">От</div><div class="detail-val" style="color:var(--red);cursor:pointer" onclick="openAddr(\''+tx.from+'\')">'+tx.from+'</div></div>'+
    '<div class="detail-row"><div class="detail-key">Кому</div><div class="detail-val" style="color:var(--green);cursor:pointer" onclick="openAddr(\''+tx.to+'\')">'+tx.to+'</div></div>'+
    '<div class="detail-row"><div class="detail-key">Сумма</div><div class="detail-val" style="color:var(--accent2)">'+tx.amount+' QTR</div></div>'+
    '<div class="detail-row"><div class="detail-key">Комиссия</div><div class="detail-val">'+tx.fee+' QTR</div></div>'+
    '<div class="detail-row"><div class="detail-key">Время</div><div class="detail-val">'+fmtTime(tx.timestamp)+'</div></div>'+
    (tx.memo?'<div class="detail-row"><div class="detail-key">Заметка</div><div class="detail-val">'+tx.memo+'</div></div>':'')+
    '<div class="detail-row"><div class="detail-key">Подпись</div><div class="detail-val">'+(signed?'<span class="badge green">✓ ECDSA</span>':'<span class="badge">Системная</span>')+'</div></div>'+
    '<div class="detail-row"><div class="detail-key">Статус</div><div class="detail-val">'+(d.confirmed===false?'<span class="badge gold">⧖ Ожидает</span>':'<span class="badge green">✓ Подтверждена</span> '+(conf!==undefined?conf+' подтв.':''))+'</div></div>'+
    (d.block!==undefined?'<div class="detail-row"><div class="detail-key">Блок</div><div class="detail-val" style="color:var(--accent);cursor:pointer" onclick="openBlock(\''+d.blockHash+'\')">#'+d.block+'</div></div>':'');
}

async function openBlock(hash){const d=await api('/block/'+hash);if(d.error){toast('Не найдено','err');return;}openModal('block',d);}
async function openTx(id){const d=await api('/tx/'+id);if(d.error){toast('Не найдено','err');return;}openModal('tx',d);}

async function openAddr(address){
  openModal('addr',address);
  const[bal,hist]=await Promise.all([api('/balance/'+address),api('/history/'+address+'?limit=20')]);
  const txRows=(hist.history||[]).map(tx=>{const isIn=tx.to===address;return'<div class="tx-item" onclick="openTx(\''+tx.id+'\')'+'"><div><div class="tx-dir '+(isIn?'in':'out')+'">'+(isIn?'↙':'↗')+'</div><div class="tx-peer">'+(isIn?short(tx.from):short(tx.to))+'</div></div><div class="tx-right"><div class="tx-amount '+(isIn?'in':'out')+'">'+(isIn?'+':'-')+tx.amount+'</div><div class="tx-meta">'+timeAgo(tx.timestamp)+'</div></div></div>';}).join('');
  const qDiv=document.createElement('div');
  qDiv.style='display:inline-block;background:#fff;border-radius:10px;padding:8px;margin-bottom:12px';
  if(window.QRCode)new QRCode(qDiv,{text:address,width:80,height:80,colorDark:'#000',colorLight:'#fff'});
  document.getElementById('modal-body').innerHTML='<div class="modal-title">Адрес <button class="modal-close" onclick="closeModal()">✕</button></div><div style="text-align:center" id="_qph"></div><div class="detail-row"><div class="detail-key">Адрес</div><div class="detail-val" style="cursor:pointer" onclick="copyText(\''+address+'\')">'+address+'</div></div><div class="detail-row"><div class="detail-key">Баланс</div><div class="detail-val" style="color:var(--green)">'+(bal.balance||0).toFixed(6)+' QTR</div></div>'+(bal.pendingOut>0?'<div class="detail-row"><div class="detail-key">В обработке</div><div class="detail-val" style="color:var(--accent2)">'+bal.pendingOut+' QTR</div></div>':'')+'<div style="margin-top:14px"><div class="label" style="margin-bottom:10px">Транзакции</div><div class="tx-list">'+(txRows||'<div class="empty">Нет</div>')+'</div></div>';
  document.getElementById('_qph').appendChild(qDiv);
}

async function showMnemonic(){
  const pass=document.getElementById('mn-pass')?.value;
  if(!pass){toast('Введите пароль','err');return;}
  const res=await api('/auth/mnemonic',{method:'POST',body:JSON.stringify({password:pass})});
  const el=document.getElementById('mn-result');
  if(res.error){el.innerHTML='<div style="color:var(--red);font-family:var(--mono);font-size:13px">'+res.error+'</div>';return;}
  const words=res.mnemonic.split(' ');
  el.innerHTML='<div class="label" style="margin-bottom:8px">Ваш мнемоник</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">'+words.map((w,i)=>'<div style="background:var(--bg3);border:1px solid var(--border);border-radius:7px;padding:7px 10px;font-family:var(--mono);font-size:12px;text-align:center"><span style="color:var(--muted);font-size:10px;display:block">'+(i+1)+'</span>'+w+'</div>').join('')+'</div><button class="btn btn-ghost btn-sm btn-full" style="margin-top:10px" onclick="copyText(\''+res.mnemonic+'\')">Скопировать</button>';
}

function pasteQR(){const v=document.getElementById('qr-paste')?.value.trim();if(v){document.getElementById('s-to').value=v;closeModal();toast('Адрес вставлен','info');}}

async function loadMining(){
  const addr=S.me?.address||'';
  if(addr){const h=document.getElementById('m-addr-hint');if(h)h.textContent=addr;}

  const [poolStats,lb,myWorker]=await Promise.all([
    fetch('/pool/stats').then(r=>r.json()).catch(()=>null),
    fetch('/pool/leaderboard').then(r=>r.json()).catch(()=>null),
    addr?fetch('/pool/worker/'+encodeURIComponent(addr)).then(r=>r.json()).catch(()=>null):Promise.resolve(null)
  ]);

  if(poolStats&&!poolStats.error){
    setText('m-workers',poolStats.activeWorkers??'0');
    setText('m-shares',poolStats.totalShares??'0');
    setText('m-job',poolStats.currentJob?'#'+poolStats.currentJob.index:'—');
    setText('m-fee',poolStats.poolFee||'2%');
  }else{
    ['m-workers','m-shares','m-job','m-fee'].forEach(id=>setText(id,'пул офлайн'));
  }

  const myEl=document.getElementById('m-my-stats');
  if(myWorker&&!myWorker.error){
    const hr=myWorker.hashrate||0;
    const hrStr=hr>=1e6?(hr/1e6).toFixed(2)+' MH/s':hr>=1000?(hr/1000).toFixed(1)+' kH/s':hr>0?hr+' H/s':'—';
    myEl.innerHTML='<div class="stats-grid" style="grid-template-columns:repeat(3,1fr)">'+
      '<div class="stat-card"><div class="stat-label">Шары</div><div class="stat-val green">'+myWorker.shares+'</div></div>'+
      '<div class="stat-card"><div class="stat-label">Доля</div><div class="stat-val gold">'+myWorker.percent+'%</div></div>'+
      '<div class="stat-card"><div class="stat-label">Хэшрейт</div><div class="stat-val blue">'+hrStr+'</div></div>'+
      '</div>';
  }else{
    myEl.innerHTML='<div class="empty">Ваш адрес не активен в пуле — запустите майнер</div>';
  }

  const lbEl=document.getElementById('m-leaderboard');
  if(!lb?.leaderboard?.length){lbEl.innerHTML='<div class="empty">Майнеров пока нет</div>';return;}
  const medals=['🥇','🥈','🥉'];
  lbEl.innerHTML=lb.leaderboard.map((w,i)=>{
    const hr=w.hashrate||0;
    const hrStr=hr>=1e6?(hr/1e6).toFixed(2)+' MH/s':hr>=1000?(hr/1000).toFixed(1)+' kH/s':hr>0?hr+' H/s':'—';
    const isMe=w.address===addr;
    return'<div class="lb-row'+(isMe?' me':'')+'">'+
      '<div class="lb-medal">'+(medals[i]||'#'+(i+1))+'</div>'+
      '<div class="lb-info">'+
        '<div class="lb-addr">'+short(w.address,10)+(isMe?' <span class="badge green">Вы</span>':'')+
          (w.active?' <span class="badge" style="color:var(--green);font-size:10px">● онлайн</span>':' <span class="badge" style="font-size:10px">офлайн</span>')+'</div>'+
        '<div class="lb-meta">шар: '+w.shares+' · '+w.percent+'% · '+hrStr+'</div>'+
      '</div>'+
      '<div class="lb-right"><div class="lb-shares">'+w.shares+'</div><div class="lb-pct">'+w.percent+'%</div></div>'+
    '</div>';
  }).join('');
}

function startRefresh(){
  loadDashboard();
  setInterval(async()=>{
    const stats=await loadDashboard();
    const active=document.querySelector('.page.active')?.id;
    if(active==='page-wallet')loadWallet();
    if(active==='page-mempool')loadMempool();
    if(active==='page-mining')loadMining();
    if(active==='page-stats'&&stats&&!stats.error)updateLiveCharts(stats);
  },4000);
}

(async()=>{
  const me=await api('/auth/me');
  if(!me.address){window.location.href='/';return;}
  S.me=me;
  prefillSend();
  startRefresh();
})();

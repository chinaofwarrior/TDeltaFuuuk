'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  wsUrl:$('wsUrl'),connectBtn:$('connectBtn'),demoBtn:$('demoBtn'),voiceBtn:$('voiceBtn'),clearBtn:$('clearBtn'),
  statusDot:$('statusDot'),statusText:$('statusText'),latency:$('latency'),frameRate:$('frameRate'),
  teamCount:$('teamCount'),contactCount:$('contactCount'),nearest:$('nearest'),riskLevel:$('riskLevel'),
  radar:$('radar'),range:$('range'),rangeLabel:$('rangeLabel'),primaryAlert:$('primaryAlert'),
  threatList:$('threatList'),teamList:$('teamList'),supplyList:$('supplyList'),eventLog:$('eventLog'),clock:$('clock')
};

const ctx = els.radar.getContext('2d');
const state = {
  socket:null, connected:false, demoTimer:null, voice:true, range:120,
  self:null, teammates:new Map(), contacts:new Map(), frameTimes:[],
  lastFrameAt:0, lastSpeech:new Map(), eventKeys:new Map(), latency:null
};

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const num=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const optionalNum=(v)=>Number.isFinite(Number(v))?Number(v):null;
const dist=(a,b)=>Math.hypot(num(a.x)-num(b.x),num(a.y)-num(b.y));
const bearing=(a,b)=>(Math.atan2(num(b.y)-num(a.y),num(b.x)-num(a.x))*180/Math.PI+360)%360;
const normalizeAngle=(d)=>(d+540)%360-180;
const htmlEscape=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const cleanText=(v)=>v===undefined||v===null?'':String(v);

function directionText(me,target){
  const d=normalizeAngle(bearing(me,target)-num(me.yaw));
  if(d>=-22.5&&d<22.5)return '正前方';
  if(d>=22.5&&d<67.5)return '右前方';
  if(d>=67.5&&d<112.5)return '右侧';
  if(d>=112.5&&d<157.5)return '右后方';
  if(d>=157.5||d<-157.5)return '正后方';
  if(d>=-157.5&&d<-112.5)return '左后方';
  if(d>=-112.5&&d<-67.5)return '左侧';
  return '左前方';
}

function logEvent(text,level='info',key=''){
  const t=Date.now();
  if(key){
    const last=state.eventKeys.get(key)||0;
    if(t-last<2500)return;
    state.eventKeys.set(key,t);
  }
  const row=document.createElement('div');
  row.className='event '+level;
  const stamp=new Date().toLocaleTimeString('zh-CN',{hour12:false});
  row.innerHTML=`<span>[${stamp}]</span> <b>${htmlEscape(text)}</b>`;
  els.eventLog.prepend(row);
  while(els.eventLog.children.length>100)els.eventLog.lastChild.remove();
}

function speak(text,key='global',cooldown=4500){
  if(!state.voice||!('speechSynthesis' in window))return;
  const t=Date.now(), last=state.lastSpeech.get(key)||0;
  if(t-last<cooldown)return;
  state.lastSpeech.set(key,t);
  const u=new SpeechSynthesisUtterance(text);
  u.lang='zh-CN'; u.rate=1.15; u.pitch=1;
  speechSynthesis.speak(u);
}

function setStatus(kind,text){
  els.statusDot.className='dot '+kind;
  els.statusText.textContent=text;
  state.connected=kind==='live';
}

function normalizeEquipment(raw={}){
  const e=raw.equipment||raw.loadout||{};
  return {
    primary:cleanText(e.primary??e.weapon??raw.weapon),
    secondary:cleanText(e.secondary),
    helmet:cleanText(e.helmet??raw.helmet),
    armor:cleanText(e.armor??e.vest??raw.armor),
    armorDurability:optionalNum(e.armorDurability??e.armor_durability??raw.armorDurability),
    armorMax:optionalNum(e.armorMax??e.armor_max??raw.armorMax),
    backpack:cleanText(e.backpack),
    optic:cleanText(e.optic),
    ammoType:cleanText(e.ammoType??e.ammo_type??raw.ammoType),
    gearValue:optionalNum(e.value??e.gearValue??raw.gearValue)
  };
}

function normalizeSupplies(raw={}){
  const s=raw.supplies||raw.inventory||{};
  return {
    ammo:optionalNum(s.ammo??raw.ammo),
    magazines:optionalNum(s.magazines??s.mags),
    medkits:optionalNum(s.medkits??s.medkit),
    bandages:optionalNum(s.bandages),
    armorRepair:optionalNum(s.armorRepair??s.armor_repair??s.repair),
    grenades:optionalNum(s.grenades??s.frag),
    smoke:optionalNum(s.smoke??s.smokes),
    food:optionalNum(s.food),
    water:optionalNum(s.water),
    value:optionalNum(s.value??s.supplyValue)
  };
}

function normalizeEntity(raw,kind){
  if(!raw||raw.id===undefined)return null;
  return {
    id:String(raw.id),name:String(raw.name||raw.id),kind,
    x:num(raw.x),y:num(raw.y),z:num(raw.z),yaw:num(raw.yaw),
    downed:Boolean(raw.downed),action:String(raw.action||''),
    hp:optionalNum(raw.hp??raw.health),
    maxHp:optionalNum(raw.maxHp??raw.max_health),
    confidence:clamp(num(raw.confidence,1),0,1),source:String(raw.source||'unknown'),
    equipmentSource:String(raw.equipment_source||raw.equipmentSource||raw.source||'unknown'),
    equipment:normalizeEquipment(raw),supplies:normalizeSupplies(raw),
    ts:num(raw.ts,Date.now()),receivedAt:Date.now()
  };
}

function mergeKnown(oldObj,newObj){
  const out={...(oldObj||{})};
  for(const [k,v] of Object.entries(newObj||{})){
    if(v!==null&&v!==undefined&&v!=='')out[k]=v;
  }
  return out;
}

function upsertTrack(map,e){
  const old=map.get(e.id);
  if(old){
    const dt=Math.max((e.ts-old.ts)/1000,.02);
    e.vx=(e.x-old.x)/dt; e.vy=(e.y-old.y)/dt; e.vz=(e.z-old.z)/dt;
    e.equipment=mergeKnown(old.equipment,e.equipment);
    e.supplies=mergeKnown(old.supplies,e.supplies);
    if(e.hp===null)e.hp=old.hp;
    if(e.maxHp===null)e.maxHp=old.maxHp;
  }else{ e.vx=0;e.vy=0;e.vz=0; }
  map.set(e.id,e);
}

function ingest(payload){
  if(!payload||typeof payload!=='object')return;
  const received=Date.now();
  if(payload.type==='pong'&&payload.echo){
    state.latency=Math.max(0,Date.now()-num(payload.echo));
    return;
  }
  if(payload.self){
    const me=normalizeEntity(payload.self,'self');
    if(me){
      if(state.self){
        me.equipment=mergeKnown(state.self.equipment,me.equipment);
        me.supplies=mergeKnown(state.self.supplies,me.supplies);
      }
      state.self=me;
    }
  }
  for(const raw of (payload.teammates||payload.team||[])){
    const e=normalizeEntity(raw,'team'); if(e)upsertTrack(state.teammates,e);
  }
  for(const raw of (payload.contacts||payload.targets||[])){
    const e=normalizeEntity(raw,'contact'); if(e)upsertTrack(state.contacts,e);
  }
  if(payload.event?.text)logEvent(payload.event.text,payload.event.level||'info');
  const sourceTs=num(payload.ts,received);
  state.latency=Math.max(0,received-sourceTs);
  state.lastFrameAt=received;
  state.frameTimes.push(received);
  state.frameTimes=state.frameTimes.filter(t=>received-t<1000);
  analyze();
}

function threatFor(e){
  if(!state.self)return {score:0,distance:Infinity,closing:0,direction:'--'};
  const d=dist(state.self,e);
  const rx=e.x-state.self.x, ry=e.y-state.self.y;
  const radial=((e.vx||0)*rx+(e.vy||0)*ry)/Math.max(d,.001);
  const closing=-radial;
  const proximity=clamp(1-d/120,0,1);
  const approach=clamp(closing/8,0,1);
  const stale=clamp(1-(Date.now()-e.receivedAt)/12000,0,1);
  const confidence=e.confidence??1;
  const score=clamp((proximity*.62+approach*.25+confidence*.13)*stale,0,1);
  return {score,distance:d,closing,direction:directionText(state.self,e),stale};
}

function armorPct(e){
  const d=e?.equipment?.armorDurability, m=e?.equipment?.armorMax;
  return d!==null&&d!==undefined&&m?clamp(d/m*100,0,100):null;
}

function equipmentText(e){
  const q=e?.equipment||{}, parts=[];
  if(q.primary)parts.push(q.primary);
  if(q.ammoType)parts.push(q.ammoType);
  if(q.armor)parts.push(q.armor);
  const ap=armorPct(e); if(ap!==null)parts.push(`甲${ap.toFixed(0)}%`);
  if(q.helmet)parts.push(q.helmet);
  return parts.length?parts.join(' · '):'装备未知';
}

function supplyText(e){
  const s=e?.supplies||{}, parts=[];
  if(s.ammo!==null&&s.ammo!==undefined)parts.push(`弹${s.ammo}`);
  if(s.medkits!==null&&s.medkits!==undefined)parts.push(`医疗${s.medkits}`);
  if(s.armorRepair!==null&&s.armorRepair!==undefined)parts.push(`修甲${s.armorRepair}`);
  if(s.grenades!==null&&s.grenades!==undefined)parts.push(`雷${s.grenades}`);
  if(s.smoke!==null&&s.smoke!==undefined)parts.push(`烟${s.smoke}`);
  return parts.length?parts.join(' · '):'补给未知';
}

function analyzeSupply(e,isMate=true){
  if(!e)return;
  const s=e.supplies||{}, ap=armorPct(e);
  if(isMate&&s.ammo!==null&&s.ammo!==undefined&&s.ammo<30){
    const msg=`${e.name} 弹药偏低，仅剩 ${s.ammo}`;
    logEvent(msg,'warn',`ammo:${e.id}`); speak(msg,`ammo:${e.id}`,12000);
  }
  if(isMate&&s.medkits!==null&&s.medkits!==undefined&&s.medkits===0){
    const msg=`${e.name} 医疗耗尽`;
    logEvent(msg,'warn',`med:${e.id}`); speak(msg,`med:${e.id}`,15000);
  }
  if(isMate&&ap!==null&&ap<25){
    const msg=`${e.name} 护甲耐久低于四分之一`;
    logEvent(msg,'warn',`armor:${e.id}`); speak(msg,`armor:${e.id}`,15000);
  }
}

function analyze(){
  const t=Date.now();
  for(const [id,e] of state.contacts)if(t-e.receivedAt>15000)state.contacts.delete(id);
  for(const [id,e] of state.teammates)if(t-e.receivedAt>12000)state.teammates.delete(id);

  const threats=[...state.contacts.values()].map(e=>({e,...threatFor(e)})).sort((a,b)=>b.score-a.score);
  const top=threats[0];

  if(top){
    els.nearest.textContent=`${Math.round(Math.min(...threats.map(x=>x.distance)))}m`;
    const risk=top.score>=.75?'极高':top.score>=.55?'高':top.score>=.32?'警戒':'低';
    els.riskLevel.textContent=risk;
    if(top.score>=.55){
      const action=top.distance<15?'立即寻找实体掩体':top.closing>2?'目标正在快速接近':'避免重复暴露';
      const msg=`${top.direction} ${Math.round(top.distance)}米，${action}`;
      els.primaryAlert.textContent=msg; els.primaryAlert.classList.remove('hidden');
      speak(msg,`threat:${top.e.id}`,3500);
      logEvent(msg,top.score>=.75?'danger':'warn',`threat:${top.e.id}`);
    }else els.primaryAlert.classList.add('hidden');
  }else{
    els.nearest.textContent='--';els.riskLevel.textContent='安全';els.primaryAlert.classList.add('hidden');
  }

  analyzeSupply(state.self,true);
  for(const mate of state.teammates.values()){
    if(state.self){
      const d=dist(state.self,mate);
      if(mate.downed){
        const msg=`${mate.name} 已倒地，距离 ${Math.round(d)} 米`;
        logEvent(msg,'danger',`down:${mate.id}`); speak(msg,`down:${mate.id}`,8000);
      }else if(d>70){
        const msg=`${mate.name} 脱节 ${Math.round(d)} 米`;
        logEvent(msg,'warn',`gap:${mate.id}`); speak(msg,`gap:${mate.id}`,9000);
      }
    }
    analyzeSupply(mate,true);
  }
  renderLists(threats);
  renderSupplies();
  updateMetrics();
}

function renderLists(threats){
  if(!threats.length){els.threatList.className='list empty';els.threatList.textContent='当前无已知目标';}
  else{
    els.threatList.className='list';
    els.threatList.innerHTML=threats.slice(0,10).map(x=>{
      const cls=x.score>=.6?'high':x.score>=.3?'mid':'low';
      const motion=x.closing>1?`接近 +${x.closing.toFixed(1)}m/s`:x.closing<-1?`远离 ${Math.abs(x.closing).toFixed(1)}m/s`:'横移/静止';
      const intel=`${equipmentText(x.e)} · ${supplyText(x.e)}`;
      return `<div class="card intel-card"><div class="name">${htmlEscape(x.e.name)}</div><div class="meta">${x.direction} · ${x.distance.toFixed(0)}m · ${motion}</div><div class="meta intel">${htmlEscape(intel)}</div><div class="meta">来源 ${htmlEscape(x.e.equipmentSource)} · 置信 ${Math.round(x.e.confidence*100)}%</div><div class="score ${cls}">${Math.round(x.score*100)}</div></div>`;
    }).join('');
  }

  const mates=[...state.teammates.values()];
  if(!mates.length){els.teamList.className='list empty';els.teamList.textContent='当前无队友数据';}
  else{
    els.teamList.className='list';
    els.teamList.innerHTML=mates.map(m=>{
      const d=state.self?dist(state.self,m):0;
      const status=m.downed?'倒地':m.action||'在线';
      const cls=m.downed||d>70?'high':d>45?'mid':'low';
      return `<div class="card intel-card"><div class="name">${htmlEscape(m.name)}</div><div class="meta">${status} · ${d.toFixed(0)}m · ${state.self?directionText(state.self,m):'--'}</div><div class="meta intel">${htmlEscape(equipmentText(m))}</div><div class="meta">${htmlEscape(supplyText(m))}</div><div class="score ${cls}">${d.toFixed(0)}m</div></div>`;
    }).join('');
  }
}

function renderSupplies(){
  const members=[state.self,...state.teammates.values()].filter(Boolean);
  if(!members.length){els.supplyList.className='supply-grid empty';els.supplyList.textContent='等待队伍装备与补给数据';return;}
  els.supplyList.className='supply-grid';
  els.supplyList.innerHTML=members.map((m,i)=>{
    const ap=armorPct(m);
    const armor=ap===null?'--':`${ap.toFixed(0)}%`;
    const hp=m.hp===null||m.hp===undefined?'--':`${Math.round(m.hp)}${m.maxHp?'/'+Math.round(m.maxHp):''}`;
    return `<div class="supply-card">
      <div class="supply-head"><b>${htmlEscape(i===0?'我':m.name)}</b><span>${htmlEscape(m.action||'')}</span></div>
      <div class="supply-line"><span>主武器</span><strong>${htmlEscape(m.equipment?.primary||'--')}</strong></div>
      <div class="supply-line"><span>弹种</span><strong>${htmlEscape(m.equipment?.ammoType||'--')}</strong></div>
      <div class="supply-line"><span>生命 / 护甲</span><strong>${hp} / ${armor}</strong></div>
      <div class="supply-line"><span>剩余补给</span><strong>${htmlEscape(supplyText(m))}</strong></div>
    </div>`;
  }).join('');
}

function updateMetrics(){
  els.teamCount.textContent=state.teammates.size;
  els.contactCount.textContent=state.contacts.size;
  els.frameRate.textContent=`${state.frameTimes.length} Hz`;
  els.latency.textContent=state.latency===null?'-- ms':`${Math.round(state.latency)} ms`;
}

function resizeCanvas(){
  const r=els.radar.getBoundingClientRect(), dpr=Math.min(devicePixelRatio||1,2);
  const w=Math.floor(r.width*dpr),h=Math.floor(r.height*dpr);
  if(els.radar.width!==w||els.radar.height!==h){els.radar.width=w;els.radar.height=h;}
  ctx.setTransform(dpr,0,0,dpr,0,0);
}

function draw(){
  resizeCanvas();
  const w=els.radar.clientWidth,h=els.radar.clientHeight,cx=w/2,cy=h/2;
  ctx.clearRect(0,0,w,h);
  const maxR=Math.min(w,h)*.44;
  ctx.strokeStyle='rgba(77,227,255,.13)';ctx.lineWidth=1;
  for(let i=1;i<=4;i++){ctx.beginPath();ctx.arc(cx,cy,maxR*i/4,0,Math.PI*2);ctx.stroke();}
  ctx.beginPath();ctx.moveTo(cx,cy-maxR);ctx.lineTo(cx,cy+maxR);ctx.moveTo(cx-maxR,cy);ctx.lineTo(cx+maxR,cy);ctx.stroke();

  const me=state.self||{x:0,y:0,yaw:0};
  const toScreen=(e)=>{
    const dx=e.x-me.x,dy=e.y-me.y,angle=-num(me.yaw)*Math.PI/180;
    const rx=dx*Math.cos(angle)-dy*Math.sin(angle), ry=dx*Math.sin(angle)+dy*Math.cos(angle);
    const scale=maxR/state.range;
    return [cx+rx*scale,cy-ry*scale];
  };

  function entity(e,color,label,radius=5){
    const [x,y]=toScreen(e); if(Math.hypot(x-cx,y-cy)>maxR+12)return;
    ctx.fillStyle=color;ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.fill();
    ctx.font='10px system-ui';ctx.fillStyle='rgba(233,244,251,.85)';ctx.fillText(label,x+8,y+3);
  }

  for(const m of state.teammates.values())entity(m,m.downed?'#ff5c6c':'#4cf0a6',m.name,5);
  for(const e of state.contacts.values()){
    const th=threatFor(e); const alpha=.3+.7*th.stale;
    const weapon=e.equipment?.primary?` · ${e.equipment.primary}`:'';
    entity(e,`rgba(255,92,108,${alpha})`,`${e.name} ${Math.round(th.distance)}m${weapon}`,5+th.score*3);
  }
  ctx.save();ctx.translate(cx,cy);ctx.fillStyle='#4de3ff';
  ctx.beginPath();ctx.moveTo(0,-10);ctx.lineTo(7,8);ctx.lineTo(0,5);ctx.lineTo(-7,8);ctx.closePath();ctx.fill();ctx.restore();

  requestAnimationFrame(draw);
}

function connect(){
  stopDemo();
  if(state.socket){try{state.socket.close()}catch{}}
  const url=els.wsUrl.value.trim();
  if(!url)return;
  setStatus('idle','连接中…');
  try{
    const ws=new WebSocket(url);state.socket=ws;
    ws.onopen=()=>{setStatus('live','实时连接');logEvent('WebSocket 已连接');};
    ws.onmessage=(ev)=>{try{ingest(JSON.parse(ev.data))}catch(err){logEvent('收到无法解析的数据','warn','parse');}};
    ws.onerror=()=>setStatus('error','连接错误');
    ws.onclose=()=>{if(state.socket===ws){setStatus('idle','已断开');logEvent('WebSocket 已断开','warn');}};
  }catch(err){setStatus('error','地址无效');}
}

function stopDemo(){
  if(state.demoTimer){clearInterval(state.demoTimer);state.demoTimer=null;els.demoBtn.textContent='启动 Demo';}
}

function startDemo(){
  if(state.demoTimer){stopDemo();setStatus('idle','Demo 已停止');return;}
  if(state.socket){try{state.socket.close()}catch{}state.socket=null;}
  setStatus('live','Demo 实时流');els.demoBtn.textContent='停止 Demo';
  const start=Date.now();
  state.demoTimer=setInterval(()=>{
    const t=(Date.now()-start)/1000;
    ingest({
      ts:Date.now()-12,
      self:{id:'me',name:'我',x:100,y:100,z:0,yaw:(t*3)%360,hp:86,maxHp:100,
        equipment:{primary:'M4A1',ammoType:'5.56 AP',armor:'战术甲',armorDurability:72,armorMax:100,helmet:'三级头'},
        supplies:{ammo:118,medkits:2,armorRepair:1,grenades:1,smoke:2}},
      teammates:[
        {id:'T2',name:'二号',x:118+Math.sin(t/3)*8,y:108+Math.cos(t/4)*5,action:'前压',hp:74,maxHp:100,
          equipment:{primary:'K416',ammoType:'5.56',armor:'重甲',armorDurability:58,armorMax:100},
          supplies:{ammo:64,medkits:1,armorRepair:1,grenades:2,smoke:1}},
        {id:'T3',name:'三号',x:88,y:125+Math.sin(t/2)*4,action:'架枪',hp:100,maxHp:100,
          equipment:{primary:'SR-25',ammoType:'7.62',armor:'轻甲',armorDurability:93,armorMax:100},
          supplies:{ammo:42,medkits:2,armorRepair:0,grenades:0,smoke:2}},
        {id:'T4',name:'四号',x:55-Math.sin(t/5)*22,y:75,action:t%20<6?'治疗':'移动',hp:61,maxHp:100,
          equipment:{primary:'MP5',ammoType:'9mm',armor:'轻甲',armorDurability:19,armorMax:100},
          supplies:{ammo:24,medkits:t%20<6?0:1,armorRepair:0,grenades:1,smoke:0}}
      ],
      contacts:[
        {id:'E1',name:'目标 A',x:150-t%18*2.2,y:108+Math.sin(t)*3,confidence:.92,source:'visual',equipment_source:'team-report',
          equipment:{primary:'SCAR-H',armor:'重甲',armorDurability:80,armorMax:100,helmet:'高级头'},supplies:{ammo:90}},
        {id:'E2',name:'目标 B',x:70,y:155-Math.sin(t/4)*18,confidence:.67,source:'team-report',
          equipment:{primary:'SMG',armor:'轻甲'},supplies:{}}
      ]
    });
  },100);
}

els.connectBtn.addEventListener('click',connect);
els.demoBtn.addEventListener('click',startDemo);
els.voiceBtn.addEventListener('click',()=>{
  state.voice=!state.voice;els.voiceBtn.textContent=`语音：${state.voice?'开':'关'}`;
  if(!state.voice&&'speechSynthesis'in window)speechSynthesis.cancel();
});
els.clearBtn.addEventListener('click',()=>{
  state.teammates.clear();state.contacts.clear();state.self=null;els.eventLog.innerHTML='';analyze();
});
els.range.addEventListener('input',()=>{
  state.range=num(els.range.value,120);els.rangeLabel.textContent=`${state.range}m`;
});

setInterval(()=>{
  els.clock.textContent=new Date().toLocaleTimeString('zh-CN',{hour12:false});
  if(state.lastFrameAt&&Date.now()-state.lastFrameAt>3000&&state.connected&&!state.demoTimer)setStatus('error','数据超时');
  updateMetrics();
},500);

const params=new URLSearchParams(location.search);
if(params.get('ws'))els.wsUrl.value=params.get('ws');
draw();
analyze();

// Live fusion: independently authenticated player states, event-only uncertain reports.
import { normalize, mergeSparse } from '../core/observation.js';
const ms=()=>Date.now();
function mergeState(old, o) {
  const next = {...old};
  for (const key of ['hp','max_hp','heading','action','downed','stance','ammo','medkits','armor_repair','smoke','grenades']) if (o[key]!==undefined && o[key]!==null) next[key]=o[key];
  if (o.position) next.position=mergeSparse(next.position || {},o.position);
  if (o.equipment) next.equipment=mergeSparse(next.equipment || {},o.equipment);
  if (o.supplies) next.supplies=mergeSparse(next.supplies || {},o.supplies);
  // Accept low-frequency flat status fields from manual providers.
  for (const key of ['ammo','medkits','armor_repair','smoke','grenades']) if(o[key]!==undefined && o[key]!==null) {
    next.supplies={...(next.supplies || {}),[key]:o[key]};
  }
  return next;
}
class Track {
  constructor(id,kind,obs,now) {
    this.id=id;this.kind=kind;this.position=obs.position?{...obs.position}:null;
    this.velocity={vx:0,vy:0,vz:0};this.heading=obs.heading??null;
    this.sigma=obs.position?6:null;this.baseConfidence=obs.confidence??.35;
    this.sources=new Set([obs.source+'|'+(obs.observer_id||'')]);
    this.observers=new Set(obs.observer_id?[obs.observer_id]:[]);
    this.lastSeen=now;this.lastPredict=now;this.state=mergeState({},obs);
    this.evidence=[{source:obs.source,observer:obs.observer_id||null,at:now}];
  }
  predict(now) {
    const dt=Math.max(0,(now-this.lastPredict)/1000);
    if(dt===0)return;
    if(this.position){
      this.position.x+=this.velocity.vx*dt;
      this.position.y+=this.velocity.vy*dt;
      this.position.z=(this.position.z||0)+this.velocity.vz*dt;
      this.sigma=Math.min(150,(this.sigma||6)+1.2*dt);
    }
    this.lastPredict=now;
  }
  update(obs,now){
    this.predict(now);
    const dt=Math.max(.05,(now-this.lastSeen)/1000);
    if(obs.position){
      if(this.position){
        const dx=obs.position.x-this.position.x,dy=obs.position.y-this.position.y;
        const dz=(obs.position.z||0)-(this.position.z||0);
        this.position={...this.position,x:this.position.x+.7*dx,y:this.position.y+.7*dy,z:(this.position.z||0)+.7*dz,
          floor:obs.position.floor??this.position.floor};
        const beta=.12/Math.max(.5,dt);
        this.velocity.vx+=beta*dx;this.velocity.vy+=beta*dy;this.velocity.vz+=beta*dz;
        this.sigma=Math.max(1.5,(this.sigma||6)*.65);
      }else{this.position={...obs.position};this.sigma=6;}
    }
    if(obs.heading!==undefined)this.heading=obs.heading;
    const sourceKey=obs.source+'|'+(obs.observer_id||'');
    if(!this.sources.has(sourceKey)){
      this.baseConfidence=1-(1-this.baseConfidence)*(1-(obs.confidence??.35));
      this.sources.add(sourceKey);
    }else this.baseConfidence=Math.max(this.baseConfidence,obs.confidence??.35);
    if(obs.observer_id)this.observers.add(obs.observer_id);
    this.state=mergeState(this.state,obs);
    this.evidence.push({source:obs.source,observer:obs.observer_id||null,at:now});
    if(this.evidence.length>32)this.evidence.shift();
    this.lastSeen=now;
  }
  snapshot(now){
    const age=now-this.lastSeen;
    return {id:this.id,kind:this.kind,position:this.position,velocity:this.velocity,heading:this.heading,
      sigma:this.sigma,confidence:Math.round(this.baseConfidence*Math.exp(-Math.max(0,age)/14000)*100)/100,
      source:[...new Set(this.evidence.map(e=>e.source))],source_diversity:this.sources.size,
      observers:[...this.observers],last_seen:this.lastSeen,age_ms:age,state:this.state};
  }
}
export class FusionEngine {
  constructor({viewerId='T1',enemyTtlMs=15000,peerTtlMs=6000}={}){
    this.viewerId=viewerId;this.enemyTtlMs=enemyTtlMs;this.peerTtlMs=peerTtlMs;
    this.players=new Map();this.enemies=new Map();this.reports=new Map();this.seenObsIds=new Map();
  }
  ingest(raw,{agentId='local'}={}){
    let o;try{o=normalize(raw);}catch{return false;}
    const now=ms();
    if(o.observed_at<now-60000)return false;
    const key=agentId+':'+o.observation_id;
    if(this.seenObsIds.has(key))return true;
    this.seenObsIds.set(key,now);
    if(this.seenObsIds.size>12000)for(const [k,v] of this.seenObsIds)if(v<now-30000)this.seenObsIds.delete(k);
    o.observer_id=agentId;
    if(o.subject.kind==='SELF'){
      const old=this.players.get(agentId);
      const state=mergeState(old?.state||{id:agentId,kind:'SELF'},o);
      state.id=agentId;
      this.players.set(agentId,{state,lastSeen:now});
      return true;
    }
    if(o.subject.kind==='TEAMMATE'){
      // A peer report is evidence, not authoritative state of a different authenticated player.
      const rid='report:'+o.observation_id;
      this.reports.set(rid,{id:rid,type:'TEAM_REPORT',sector:o.sector||null,
        text:o.text||'队友状态报告',observer_id:agentId,at:now,confidence:o.confidence,ttl_ms:8000});
      return true;
    }
    if(o.subject.kind!=='OBSERVED_ENEMY' && o.subject.kind!=='PREDICTED_ENEMY')return true;
    const observer=this.players.get(agentId)?.state;
    const pos=resolvePosition(o,observer);
    if(!pos){
      const rid='report:'+o.observation_id;
      this.reports.set(rid,{id:rid,type:o.type,sector:o.sector||null,bearing:o.bearing??null,
        distance_estimate:o.distance_estimate??null,observer_id:agentId,at:now,
        confidence:o.confidence,ttl_ms:Math.min(15000,o.ttl_ms||10000)});
      return true;
    }
    const kind=o.subject.kind;
    const id=this.associate(o,pos,kind,now) || (o.subject.id && o.subject.id!=='E-MANUAL'?o.subject.id: o.observation_id);
    o.position=pos;
    const old=this.enemies.get(id);
    if(old)old.update(o,now);else this.enemies.set(id,new Track(id,kind,o,now));
    return true;
  }
  associate(o,pos,kind,now){
    if(o.subject.id && this.enemies.has(o.subject.id)) {
      const known=this.enemies.get(o.subject.id);
      if(known.kind===kind && now-known.lastSeen<10000 && known.position &&
        Math.hypot(known.position.x-pos.x,known.position.y-pos.y)<Math.max(8,(known.sigma||5)*2.5))return known.id;
    }
    let best=null,bestD=Infinity;
    for(const t of this.enemies.values()){
      if(t.kind!==kind||!t.position||now-t.lastSeen>10000)continue;
      if(pos.floor!==undefined && t.position.floor!==undefined && pos.floor!==t.position.floor)continue;
      t.predict(now);
      const d=Math.hypot(t.position.x-pos.x,t.position.y-pos.y);
      const gate=Math.max(4,(t.sigma||6)*2);
      if(d<gate && d<bestD){bestD=d;best=t.id;}
    }
    return best;
  }
  decayNow(now=ms()){
    for(const [id,t] of this.enemies){t.predict(now);if(now-t.lastSeen>this.enemyTtlMs)this.enemies.delete(id);}
    for(const [id,r] of this.reports)if(now-r.at>r.ttl_ms)this.reports.delete(id);
    for(const [id,v] of this.players)if(now-v.lastSeen>this.peerTtlMs)this.players.delete(id);
    for(const [id,t] of this.seenObsIds)if(now-t>30000)this.seenObsIds.delete(id);
  }
  worldState(viewerId=this.viewerId){
    const now=ms();this.decayNow(now);
    const viewer=this.players.get(viewerId)?.state;
    const first=this.players.values().next().value?.state;
    const self=viewer||first||{id:viewerId,kind:'SELF'};
    const teammates={};
    for(const [id,v] of this.players)if(id!==self.id)teammates[id]={id,position:v.state.position||null,
      heading:v.state.heading??null,state:v.state,last_seen:v.lastSeen,age_ms:now-v.lastSeen};
    return {self,viewer_id:self.id,teammates,
      enemies:[...this.enemies.values()].map(t=>t.snapshot(now)),
      reports:[...this.reports.values()].map(r=>({...r,age_ms:now-r.at})),updated_at:now};
  }
}
function resolvePosition(o,observer){
  if(o.position)return {...o.position};
  // Unknown range remains an uncertain bearing/sector report; never forge a 20m coordinate.
  if(o.bearing==null || o.distance_estimate==null || !observer?.position)return null;
  const theta=((observer.heading||0)+o.bearing)*Math.PI/180;
  return {x:observer.position.x+Math.cos(theta)*o.distance_estimate,
    y:observer.position.y+Math.sin(theta)*o.distance_estimate,
    z:observer.position.z||0,floor:observer.position.floor};
}

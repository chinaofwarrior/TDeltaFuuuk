// TDeltaFuuuk Hub 主程序。
// 功能：控制台 HTTP(127.0.0.1:17888) + 队友上报(0.0.0.0:17889) + SSE 实时推送
//      + 局域网发现(17892) + 融合/战术引擎 + DF 账号绑定。

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';
import {randomBytes,timingSafeEqual} from 'node:crypto';

import { FusionEngine } from './fusion/engine.js';
import { TacticsEngine } from './tactics/engine.js';
import { DiscoveryServer, PORTS } from './transport/net.js';
import { DFAccountAdapter } from './adapters/dfapi.js';
import { loadConfig, saveJson, CredentialStore, logger, genId, ensureDir } from './util.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const UI_DIR = join(ROOT, 'webui');

const DEFAULTS = {
  name: 'TDeltaFuuuk-Hub',
  sharedToken: '',
  hubHttpPort: PORTS.HUB_HTTP,
  ingestPort: PORTS.HUB_INGEST,
  discoveryPort: PORTS.DISCOVERY,
  dfBaseUrl: '',
  sseIntervalMs: 50,
  viewerId: 'T1',
  peers: {},
};

export class Hub {
  constructor(configPath) {
    this.configPath = configPath || join(ROOT, 'tdelta-hub.json');
    this.config = loadConfig(this.configPath, DEFAULTS);
    if (!this.config.sharedToken) {
      this.config.sharedToken = genId('tk').toLowerCase().replace('_', '');
      saveJson(this.configPath, this.config);
    }
    // Separate per-member pairing credentials. Never put them in discovery packets.
    if(!this.config.peers)this.config.peers={};
    for(const [id,name] of [['T2','二号'],['T3','三号'],['T4','四号']]){
      if(!this.config.peers[id])this.config.peers[id]={name,token:randomBytes(24).toString('hex')};
    }
    this.config.peers={...this.config.peers};
    saveJson(this.configPath,this.config);
    const localAgent=join(dirname(this.configPath),'TDeltaAgent.config.json');
    if(!existsSync(localAgent))saveJson(localAgent,{agentId:this.config.viewerId,
      sharedToken:this.config.sharedToken,hubUrl:'http://127.0.0.1:'+this.config.ingestPort,
      providersDir:join(ROOT,'src','providers')});
    const invites=join(dirname(this.configPath),'invites');ensureDir(invites);
    for(const [id,peer] of Object.entries(this.config.peers)){
      const path=join(invites,peer.name+'.join.json');
      if(!existsSync(path))saveJson(path,{agentId:id,token:peer.token,hubUrl:''});
    }
    this.peerStatusMap=new Map();
    this.accountsStore = new CredentialStore(join(dirname(this.configPath), 'tdelta-accounts.enc.json'));
    this.accounts = this.accountsStore.load(); // { [accountId]: { token } }
    this.fusion = new FusionEngine({viewerId:this.config.viewerId});
    this.tactics = new TacticsEngine({});
    this.sseClients = new Set();
    this.dfAdapters = {}; // accountId -> DFAccountAdapter
    this.accountProfiles = {}; // accountId -> 已拉取的账号资料
    this.discovery = new DiscoveryServer({ ingestPort: this.config.ingestPort, name: this.config.name, port:this.config.discoveryPort });
    this.server = null;
    this.ingestServer = null;
    this.timers = [];
  }

  async start() {
    // 局域网发现
    await this.discovery.start();

    // 控制台 HTTP（loopback only，对应原始 README「只绑定 loopback」）
    this.server=http.createServer((req,res)=>{Promise.resolve(this.route(req,res)).catch(e=>{
      if(!res.writableEnded&&!res.destroyed)json(res,e.status||500,{error:e.status?e.message:'request failed'});
    });});
    await new Promise((ok,fail)=>{this.server.once('error',fail);this.server.listen(this.config.hubHttpPort, '127.0.0.1', () => {ok();
      logger.info('hub', `控制台: http://127.0.0.1:${this.config.hubHttpPort}`);
    });});

    // 队友上报（0.0.0.0）
    this.ingestServer=http.createServer((req,res)=>{Promise.resolve(this.routeIngest(req,res)).catch(e=>{
      if(!res.writableEnded&&!res.destroyed)json(res,e.status||500,{error:e.status?e.message:'request failed'});
    });});
    await new Promise((ok,fail)=>{this.ingestServer.once('error',fail);this.ingestServer.listen(this.config.ingestPort, '0.0.0.0', () => {ok();
      logger.info('hub', `队友上报: 0.0.0.0:${this.config.ingestPort}`);
    });});

    // 融合/战术引擎周期：衰减 + SSE 广播
    const loop = setInterval(() => this.tick(), this.config.sseIntervalMs);
    this.timers.push(loop);

    logger.info('hub', '分别发送 invites/ 中对应的 .join.json 给各位队友；请勿公开或互相转发');
    logger.info('hub', `Hub「${this.config.name}」启动完成`);
  }

  // ---- 周期任务 ----
  tick() {
    this.fusion.decayNow();
    const ws = this.fusion.worldState();
    const tactics = this.tactics.evaluate(ws);
    const payload = JSON.stringify({ type: 'state', world: ws, tactics, peers:this.pairStatus() });
    for(const client of this.sseClients){
      if(client.destroyed||client.writableLength>262144){this.sseClients.delete(client);client.end();continue;}
      client.write('data: '+payload+'\n\n');
    }
  }

  // ---- 路由 ----
  async route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const host=(req.headers.host||'').split(':')[0].toLowerCase();
    if(!['localhost','127.0.0.1','[::1]'].includes(host))return json(res,403,{error:'local console only'});
    if(req.headers.origin){
      try{const origin=new URL(req.headers.origin);
        if(!['localhost','127.0.0.1'].includes(origin.hostname)||Number(origin.port||80)!==this.config.hubHttpPort)
           return json(res,403,{error:'invalid origin'});
      }catch{return json(res,403,{error:'invalid origin'});}
    }
    try {
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, join(UI_DIR, 'index.html'));
      if (req.method === 'GET' && p === '/api/state') return json(res, 200, { world: this.fusion.worldState(), tactics: this.tactics.evaluate(this.fusion.worldState()) });
      if (req.method === 'GET' && p === '/api/tactics') return json(res, 200, this.tactics.evaluate(this.fusion.worldState()));
      if (req.method === 'GET' && p === '/api/events') return this.sse(res);
      if (req.method === 'GET' && p === '/api/time') return json(res, 200, { now_ms: Date.now() });
      if (req.method === 'GET' && p === '/api/accounts') return json(res, 200, this.listAccounts());
      if(req.method==='GET'&&p==='/api/health')
        return json(res,200,{ready:true,uptime_s:Math.floor(process.uptime()),peers:this.pairStatus(),
          tracks:this.fusion.enemies.size,reports:this.fusion.reports.size});
      if(req.method==='GET' && p==='/api/peers')return json(res,200,this.pairStatus());
      if(req.method==='POST' && p==='/api/peers/rotate'){
        const b=await readBody(req,1024),id=b.id;
        if(!Object.hasOwn(this.config.peers,id))return json(res,404,{error:'unknown peer'});
        const newToken=randomBytes(24).toString('hex');
        this.config.peers[id].token=newToken;saveJson(this.configPath,this.config);
        const dir=join(dirname(this.configPath),'invites');ensureDir(dir);
        saveJson(join(dir,this.config.peers[id].name+'.join.json'),{agentId:id,token:newToken,hubUrl:''});
        this.peerStatusMap.delete(id);
        return json(res,200,{ok:true,file:'invites/'+this.config.peers[id].name+'.join.json'});
      }
      if(req.method==='POST' && p==='/api/report'){
        const b=await readBody(req,8192);
        if(!['CONTACT','ENEMY_REPORT','AUDIO_CONTACT','STATUS','SUPPLY_STATE','LOADOUT_STATE'].includes(b.type))return json(res,400,{error:'invalid report'});
        const personal=['STATUS','SUPPLY_STATE','LOADOUT_STATE'].includes(b.type);
        const kind=personal?'SELF':'OBSERVED_ENEMY';
        const ok=this.fusion.ingest({...b,subject:{kind,id:personal?this.config.viewerId:(b.target_id||'manual')},
          source:b.source==='VOICE'?'VOICE':'MANUAL',confidence:b.confidence??.65},{agentId:this.config.viewerId});
        return json(res,ok?200:400,{ok});
      }
      if (req.method === 'GET' && p === '/api/providers') return json(res, 200, this.fusionProviderList());
      if (req.method === 'POST' && p === '/api/ingest') return this.handleIngest(req, res, false);
      if (req.method === 'POST' && p === '/api/accounts/login/qr') return this.handleLoginQR(req, res);
      if (req.method === 'POST' && p === '/api/accounts/login/poll') return this.handleLoginPoll(req, res);
      if (req.method === 'POST' && p === '/api/accounts/fetch') return this.handleAccountFetch(req, res);
      if (req.method === 'POST' && p === '/api/accounts/bind') return this.handleAccountBind(req, res);
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      logger.error('hub', `路由异常 ${p}: ${e.message}`);
      return json(res,e.status||500,{error:e.status?e.message:'request failed'});
    }
  }

  // 队友上报（0.0.0.0:17889，需共享 Token）
  routeIngest(req,res){
    let id=this.memberId(req.headers.authorization);
    const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    if(!id&&local&&(req.headers.authorization||'').startsWith('Bearer ')){
      const given=Buffer.from(req.headers.authorization.slice(7)),expected=Buffer.from(this.config.sharedToken);
      if(given.length===expected.length&&timingSafeEqual(given,expected))id=this.config.viewerId;
    }
    if(!id)return json(res,401,{error:'unauthorized'});
    if(req.method==='GET'&&req.url==='/time')return json(res,200,{now_ms:Date.now()});
    if(req.method==='POST'&&req.url==='/ingest')return this.handleIngest(req,res,true,id);
    return json(res,404,{error:'not found'});
  }
  memberId(authorization){
    if(typeof authorization!=='string'||!authorization.startsWith('Bearer '))return null;
    const given=Buffer.from(authorization.slice(7));
    for(const [id,p] of Object.entries(this.config.peers)){
      const expected=Buffer.from(p.token);
      if(given.length===expected.length&&timingSafeEqual(given,expected))return id;
    }
    return null;
  }
  pairStatus(){
    return Object.entries(this.config.peers).map(([id,p])=>{
      const seen=this.peerStatusMap.get(id);
      return {id,name:p.name,online:!!seen&&Date.now()-seen.at<5000,
        age_ms:seen?Date.now()-seen.at:null,frames:seen?.frames||0};
    });
  }

  // ---- ingest ----
  async handleIngest(req,res,remote=false,authenticatedId=null){
    if(!remote){
      const a=req.headers.authorization||'';
      const given=Buffer.from(a.startsWith('Bearer ')?a.slice(7):'');
      const expected=Buffer.from(this.config.sharedToken);
      if(given.length!==expected.length||!timingSafeEqual(given,expected))
        return json(res,401,{error:'unauthorized'});
    }
    const body=await readBody(req);
    const list=Array.isArray(body.observations)?body.observations:body.observation?[body.observation]:body.type?[body]:[];
    if(list.length>128)return json(res,413,{error:'batch too large'});
    const agentId=remote?authenticatedId:this.config.viewerId;
    if(remote&&body.agent_id&&body.agent_id!==agentId)return json(res,403,{error:'invalid member ID'});
    if(remote)this.peerStatusMap.set(agentId,{at:Date.now(),frames:(this.peerStatusMap.get(agentId)?.frames||0)+list.length});
    const ack_ids=[],rejected_ids=[];
    for(const raw of list){
      if(!raw||typeof raw!=='object')continue;
      if(remote&&!['SELF','OBSERVED_ENEMY','PREDICTED_ENEMY'].includes(raw.subject?.kind||'SELF')){
        if(raw.observation_id)rejected_ids.push(raw.observation_id);
        continue;
      }
      const o={...raw,observer_id:agentId,source_instance:agentId};
      if(remote&&['OFFICIAL_API','COMMUNITY_API','AUTHORIZED_SDK'].includes(o.source)){
        o.claimed_source=o.source;
        o.source=(o.subject?.kind||'SELF')==='SELF'?'TEAM_SELF_REPORT':'TEAM_REPORT';
        o.confidence=Math.min(Number.isFinite(Number(o.confidence))?Number(o.confidence):.7,.75);
      }
      if(this.fusion.ingest(o,{agentId})){
        if(o.observation_id)ack_ids.push(o.observation_id);
      }else if(o.observation_id)rejected_ids.push(o.observation_id);
    }
    return json(res,200,{ok:true,ack_ids,rejected_ids});
  }

  // ---- SSE ----
  sse(res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });
    res.write('retry: 1000\n\n');
    this.sseClients.add(res);
    res.on('close', () => this.sseClients.delete(res));
  }

  // ---- DF 账号 ----
  listAccounts() {
    return Object.keys(this.accounts).map((id) => ({
      id,
      bound: !!this.accounts[id].token,
      profile: this.accountProfiles[id] || null,
    }));
  }

  async handleLoginQR(req, res) {
    const adapter = this._adapter();
    try {
      const qr = await adapter.loginQR();
      return json(res, 200, { ok: true, qr });
    } catch (e) {
      return json(res, 502, { ok: false, error: e.message });
    }
  }

  async handleLoginPoll(req, res) {
    const body = await readBody(req);
    const adapter = this._adapter();
    try {
      const r = await adapter.pollLogin(body.key);
      if (r && r.frameworkToken) {
        const accountId = body.accountId || 'self';
        this.accounts[accountId] = { token: r.frameworkToken };
        this.accountsStore.save(this.accounts);
        this._adapter(accountId).setToken(r.frameworkToken);
      }
      return json(res, 200, { ok: true, logged_in: !!(r && r.frameworkToken), status: r?.status || 'pending' });
    } catch (e) {
      return json(res, 502, { ok: false, error: e.message });
    }
  }

  async handleAccountBind(req, res) {
    const body = await readBody(req);
    const accountId = body.accountId || 'self';
    if (body.token) {
      this.accounts[accountId] = { token: body.token };
      this.accountsStore.save(this.accounts);
      this._adapter(accountId).setToken(body.token);
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { ok: false, error: 'missing token' });
  }

  async handleAccountFetch(req, res) {
    const body = await readBody(req);
    const accountId = body.accountId || 'self';
    const adapter = this._adapter(accountId);
    if (!this.accounts[accountId] || !this.accounts[accountId].token) {
      return json(res, 400, { ok: false, error: '账号未绑定' });
    }
    try {
      const profile = await adapter.fetchProfile();
      // 账号/历史数据属于慢元数据（Level C），不进高速融合通道，单独存档
      this.accountProfiles[accountId] = profile;
      return json(res, 200, { ok: true, profile });
    } catch (e) {
      return json(res, 502, { ok: false, error: e.message });
    }
  }

  _adapter(accountId = 'self') {
    if (!this.dfAdapters[accountId]) {
      const a = new DFAccountAdapter({ baseUrl: this.config.dfBaseUrl });
      if (this.accounts[accountId] && this.accounts[accountId].token) a.setToken(this.accounts[accountId].token);
      this.dfAdapters[accountId] = a;
    }
    return this.dfAdapters[accountId];
  }

  fusionProviderList() {
    return [];
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.discovery.stop();
    if (this.server?.listening) this.server.close();
    if (this.ingestServer?.listening) this.ingestServer.close();
    for (const c of this.sseClients) c.end();
  }
}

// ---- HTTP 工具 ----
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function serveFile(res, filePath) {
  if (!existsSync(filePath)) {
    res.writeHead(404);
    return res.end('not found');
  }
  const content = readFileSync(filePath);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(content);
}

function readBody(req,limit=262144){
  return new Promise((resolve,reject)=>{
    let body='';let finished=false;
    req.on('data',c=>{body+=c;if(body.length>limit&&!finished){finished=true;reject(Object.assign(new Error('too large'),{status:413}));req.destroy();}});
    req.on('end',()=>{if(finished)return;try{resolve(body?JSON.parse(body):{});}
      catch{reject(Object.assign(new Error('invalid JSON'),{status:400}));}});
    req.on('error',e=>{if(!finished)reject(e);});
  });
}

// ---- 入口 ----
if (process.argv[1] && process.argv[1].endsWith('hub.js')) {
  const hub = new Hub();
  hub.start().catch((e) => {
    logger.error('hub', `启动失败: ${e.message}`);
    process.exit(1);
  });
  process.on('SIGINT', () => { hub.stop(); process.exit(0); });
  process.on('SIGTERM', () => { hub.stop(); process.exit(0); });
}

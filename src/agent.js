// TDeltaAgent 主程序（玩家实时观察数据网关，《原理》第九节）。
// 功能：自动发现 Hub、加载 Provider 插件、本机 UDP/HTTP ingest、
//      观测总线(事件驱动 + 20Hz 汇聚)、时钟同步、自动重连。

import http from 'node:http';
import os from 'node:os';
import {existsSync,readdirSync,readFileSync} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {DurableQueue} from './core/durable_queue.js';

import { ProviderManager } from './providers/manager.js';
import { DiscoveryClient, HubClient, UdpIngestServer, PORTS } from './transport/net.js';
import { ClockSync } from './core/clock.js';
import { normalize } from './core/observation.js';
import { RingBuffer } from './core/ringbuffer.js';
import { loadConfig, logger, saveJson } from './util.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const DEFAULTS = {
  sharedToken: '',
  hubUrl: '',
  agentId: '',
  providersDir: join(ROOT, 'src', 'providers'),
  agentHttpPort: PORTS.AGENT_HTTP,
  agentUdpPort: PORTS.AGENT_UDP,
  flushIntervalMs: 50, // 20Hz
  clockSyncIntervalMs: 5000,
  durableEventsTtlMs: 55000,
};

export class Agent {
  constructor(configPath) {
    this.configPath = configPath || join(ROOT, 'TDeltaAgent.config.json');
    this.config = loadConfig(this.configPath, DEFAULTS);
    // A separate, private join file is the only way to import an invitation.
    { // If one new private invitation is present, it supersedes the old credential.
      const found=existsSync(ROOT)?readdirSync(ROOT).filter(n=>n.endsWith('.join.json')):[];
      if(found.length===1){
        const joinData=JSON.parse(readFileSync(join(ROOT,found[0]),'utf8'));
        this.config.sharedToken=joinData.token;
        this.config.agentId=joinData.agentId;
        this.config.hubUrl=joinData.hubUrl||'';
        saveJson(this.configPath,this.config);
      }
    }
    this.agentId = this.config.agentId || os.hostname();
    this.spool=new DurableQueue(
      this.config.durableQueuePath||join(dirname(this.configPath),'.tdelta-state',String(this.agentId).replace(/[^A-Za-z0-9_-]/g,'_')+'.json'),
      {ttlMs:this.config.durableEventsTtlMs});
    this.pending=this.spool.items;this.fast=new Map();
    this.flushBusy=false;this.lastPulse=0;this.dropped=0;this.rejected=0;
    this.flushTimer = null;
    this.clockSync = new ClockSync();
    this.hubClient = null;
    this.providers = null;
    this.httpServer = null;
    this.udpServer = null;
    this.syncTimer=null;
  }

  async start() {
    if(!this.config.sharedToken) throw new Error('缺少专属邀请文件：请把主机发送的 .join.json 放在 Agent 同目录');
    logger.info('agent', 'Agent ID: '+this.agentId);

    // 1. 发现 Hub
    let hubUrl = this.config.hubUrl;
    if (!hubUrl) {
      const found = await new DiscoveryClient({}).findHub();
      if (found) {
        hubUrl = 'http://' + found.hub_ip + ':' + found.ingest_port;
      }
    }
    if (!hubUrl) {
      logger.warn('agent', '未发现 Hub，稍后重试（可用 hubUrl 手动指定）');
    }

    this.hubClient = new HubClient({
      hubUrl,
      token: this.config.sharedToken,
      agentId: this.agentId,
      onState: (s) => logger.info('agent', `与 Hub: ${s}`),
    });
    this.hubClient.clockSync = this.clockSync;
    if(hubUrl)await this.hubClient.syncClock();

    // 2. 启动 Provider（手动报点等）
    this.providers = new ProviderManager({
      providersDir: this.config.providersDir,
      onObservation: (raw) => this.push(raw),
    });
    await this.providers.startAll();

    // 3. 本机 ingest：HTTP + UDP
    this.httpServer = http.createServer((req, res) => this.routeHttp(req, res));
    await new Promise((ok,fail)=>{this.httpServer.once('error',fail);
      this.httpServer.listen(this.config.agentHttpPort,'127.0.0.1',ok);
    });
    logger.info('agent','本地输入服务已启动');
    this.udpServer = new UdpIngestServer({ port: this.config.agentUdpPort, onData: (d) => this.push(d) });
    await this.udpServer.start();

    // 4. 事件驱动 + 20Hz 汇聚
    this.flushTimer = setInterval(() => { void this.flush(); }, this.config.flushIntervalMs);

    // 5. 时钟同步 + 重连
    this.syncTimer=setInterval(() => { void this.reconcile(); }, this.config.clockSyncIntervalMs);

    logger.info('agent', 'Agent 启动完成');
  }

  routeHttp(req,res){
    const host=(req.headers.host||'').split(':')[0].toLowerCase();
    if(!['127.0.0.1','localhost','[::1]'].includes(host)){res.writeHead(403);return res.end();}
    if(req.method==='GET'&&req.url==='/api/health'){
      res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
      return res.end(JSON.stringify(this.health()));
    }
    if(req.headers.origin){
      try{const origin=new URL(req.headers.origin);
        if(origin.hostname!=='127.0.0.1'||Number(origin.port||80)!==this.config.agentHttpPort){
          res.writeHead(403);res.end();return;
        }
      }catch{res.writeHead(403);res.end();return;}
    }
    if(req.method==='GET'&&req.url==='/'){
      res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
      const connected=this.hubClient?.connected?'已连接主机':'等待主机';
      return res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="refresh" content="3"><style>body{background:#0b1520;color:#dcf6ef;font:18px sans-serif;padding:50px}b{color:#53dca6}</style><h2>TDeltaAgent 队友客户端</h2><p>身份：'+this.agentId+'</p><p>状态：<b>'+connected+'</b></p><p>待发送关键事件：'+this.pending.size+'</p><p>过期事件：'+this.spool.expired+'</p><p>关闭客户端即停止共享。</p><hr><p>人工报点（只分享您输入的信息）</p><input id="s" placeholder="北楼二层等"><button onclick="send()">发送</button><script>async function send(){const sector=document.getElementById("s").value;if(!sector)return;await fetch("/ingest",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({type:"ENEMY_REPORT",subject:{kind:"OBSERVED_ENEMY",id:"manual-local"},sector,source:"MANUAL"})});document.getElementById("s").value="";}</script></html>');
    }
    if (req.method === 'POST' && req.url === '/ingest') {
      let body = '';
      req.on('data', (c) => { body += c; if(body.length>262144){res.writeHead(413);res.end();req.destroy();} });
      req.on('end', () => {
        if(res.writableEnded)return;
        try {
          const j = JSON.parse(body);
          const list=Array.isArray(j.observations)?j.observations:j.observation?[j.observation]:j.type?[j]:[];
          if(list.length<1||list.length>128){res.writeHead(400);return res.end('invalid batch');}
          const accepted=list.filter(o=>this.push(o)).length;
          res.writeHead(accepted===list.length?202:503,{'content-type':'application/json'});
          res.end(JSON.stringify({ok:accepted===list.length,accepted,requested:list.length}));
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, agent: this.agentId }));
  }

  push(raw) {
    try{
      const o=normalize({...raw,observer_id:this.agentId});
      const onlyPose=o.type==='ENTITY_STATE'&&!!o.position&&!o.equipment&&!o.supplies
        &&o.hp===undefined&&o.ammo===undefined&&o.downed===undefined;
      if(onlyPose)this.fast.set(o.subject.kind+':'+(o.subject.id||this.agentId),o);
      else{
        this.spool.prune();
        try{if(!this.spool.add(o)){this.dropped++;logger.error('agent','待确认队列已满');return false;}}
        catch(e){this.dropped++;logger.error('agent','事件落盘失败: '+e.message);return false;}
      }
      return true;
    }catch(e){logger.warn('agent','无效数据: '+e.message);return false;}
  }
  async flush(){
    if(this.flushBusy||!this.hubClient?.hubUrl)return;
    this.spool.prune();
    const events=this.spool.first(64);
    const poses=[...this.fast.values()].slice(0,16);
    if(events.length===0&&poses.length===0&&Date.now()-this.lastPulse<1000)return;
    this.flushBusy=true;
    try{
      const source=[...events,...poses];
      const ready=this.clockSync.samples>0&&this.clockSync.rttMs<1000;
      const batch=ready?source.map(o=>({...o,observed_at:Math.round(this.clockSync.toHub(o.observed_at)),
        original_observed_at:o.observed_at,clock_rtt_ms:this.clockSync.rttMs})):source;
      const result=await this.hubClient.sendObservations(batch);
      if(result.ok){
        this.lastPulse=Date.now();
        const ack=new Set(result.ack_ids);
        const rejected=new Set(result.rejected_ids||[]);
        this.rejected+=rejected.size;
        this.spool.ack([...ack,...rejected]);
        for(const [key,frame] of this.fast)if(ack.has(frame.observation_id)&&this.fast.get(key)===frame)this.fast.delete(key);
      }
    }finally{this.flushBusy=false;}
  }

  async reconcile() {
    if (!this.hubClient || !this.hubClient.hubUrl) {
      // 重新发现
      const found = await new DiscoveryClient({}).findHub();
      if (found) {
        this.hubClient.hubUrl = 'http://' + found.hub_ip + ':' + found.ingest_port;
        logger.info('agent', `重新发现 Hub: ${this.hubClient.hubUrl}`);
      }
    }
    await this.hubClient.syncClock();
  }

  health(){
    return {agent:this.agentId,connected:this.hubClient?.connected||false,pending:this.spool.size,
      expired:this.spool.expired,rejected:this.rejected,dropped:this.dropped,
      fast_pending:this.fast.size,clock:{samples:this.clockSync.samples,
        offset_ms:this.clockSync.offsetMs,rtt_ms:this.clockSync.rttMs},providers:this.providers?.list()||[]};
  }
  stop() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.providers) this.providers.stopAll();
    if (this.udpServer) this.udpServer.stop();
    if (this.httpServer) this.httpServer.close();
  }
}

// ---- 入口 ----
if (process.argv[1] && process.argv[1].endsWith('agent.js')) {
  const agent = new Agent();
  agent.start().catch((e) => {
    logger.error('agent', `启动失败: ${e.message}`);
    process.exit(1);
  });
  process.on('SIGINT', () => { agent.stop(); process.exit(0); });
  process.on('SIGTERM', () => { agent.stop(); process.exit(0); });
}

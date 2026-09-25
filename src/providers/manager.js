// Provider Manager（Source Manager，对应《开发方案》第九/十节）。
// 负责：发现 Provider、以子进程方式启动、握手校验 ABI 与能力契约、
// 健康检查（心跳）、崩溃隔离与自动重启、把 Observation 路由到总线。

import { spawn } from 'node:child_process';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import {createHash} from 'node:crypto';
import { join, extname, dirname, resolve as resolvePath, sep } from 'node:path';
import {fileURLToPath} from 'node:url';
import { createInterface } from 'node:readline';
import { logger, genId } from '../util.js';
import { parseHello, decodeLine, observationCapability } from './protocol.js';

const HELLO_TIMEOUT_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = 8000;
const MAX_RESTARTS = 5;

export class ProviderManager {
  constructor({ providersDir, onObservation, runtime = process.execPath } = {}) {
    this.providersDir = providersDir;
    this.onObservation = onObservation || (() => {});
    this.runtime = runtime;
    this.instances = new Map(); // providerId -> ProviderInstance
  }

  // 扫描 providersDir 下所有 *.provider.js
  discover() {
    if (!this.providersDir || !existsSync(this.providersDir)) return [];
    return readdirSync(this.providersDir)
      .filter((f) => f.endsWith('.provider.js') || f.endsWith('.provider.json'))
      .map((f) => join(this.providersDir, f));
  }

  async startAll() {
    const files = this.discover();
    if (files.length === 0) {
      logger.warn('providers', `providersDir 无 Provider: ${this.providersDir}`);
    }
    const handles = [];
    for (const f of files) handles.push(this.start(f));
    return Promise.all(handles);
  }

  start(scriptPath) {
    return new Promise((resolve) => {
      const providerId = genId('prov');
      let runtime=this.runtime,args=[scriptPath],allowed=null;
      try{
        if(scriptPath.endsWith('.provider.json')){
          const manifest=JSON.parse(readFileSync(scriptPath,'utf8'));
          const parent=resolvePath(dirname(scriptPath)),dll=resolvePath(parent,manifest.dll||'');
          if(!manifest.dll||!dll.startsWith(parent+sep)||!dll.toLowerCase().endsWith('.dll'))throw Error('invalid DLL location');
          const hash=createHash('sha256').update(readFileSync(dll)).digest('hex');
          if(!manifest.sha256||hash!==manifest.sha256.toLowerCase())throw Error('DLL checksum mismatch');
          const root=resolvePath(dirname(fileURLToPath(import.meta.url)),'..','..');
          runtime=resolvePath(root,'native','tdf-provider-host.exe');
          if(!existsSync(runtime))throw Error('native host missing');
          args=['--dll',dll];allowed=Array.isArray(manifest.capabilities)?manifest.capabilities:[];
        }
      }catch(e){logger.error('providers','拒绝插件: '+e.message);resolve({providerId,ok:false});return;}
      const inst=new ProviderInstance(this,providerId,scriptPath,runtime,this.onObservation,args,allowed);
      this.instances.set(providerId, inst);
      inst.start().then((ok) => resolve({ providerId, ok }));
    });
  }

  stopAll() {
    for (const inst of this.instances.values()) inst.stop();
    this.instances.clear();
  }

  list() {
    return [...this.instances.values()].map((i) => i.status());
  }
}

class ProviderInstance {
  constructor(mgr, id, scriptPath, runtime, onObservation, args=null, allowed=null) {
    this.mgr = mgr;
    this.id = id;
    this.scriptPath = scriptPath;
    this.runtime = runtime;
    this.args=args||[scriptPath];this.allowed=allowed;
    this.onObservation = onObservation;
    this.proc = null;
    this.hello = null;
    this.restarts = 0;
    this.lastHeartbeat = 0;
    this.startedAt = 0;
    this.stopped = false;
    this.heartbeatTimer = null;
    this.restarting = false;
  }

  start() {
    this.stopped=false;this.restarting=false;this.hello=null;
    return new Promise((resolve) => {
      this.startedAt = Date.now();
      const args=this.args;
      let proc;
      try {
        proc = spawn(this.runtime, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (e) {
        logger.error('providers', `启动失败 ${this.scriptPath}: ${e.message}`);
        resolve(false);
        return;
      }
      this.proc = proc;
      this.lastHeartbeat = Date.now();

      const rl = createInterface({ input: proc.stdout });
      const errl = createInterface({ input: proc.stderr });
      errl.on('line', (l) => logger.warn('providers', `[${this.nameHint()}] ${l}`));

      let helloTimer = setTimeout(() => {
        if (!this.hello) {
          logger.error('providers', `${this.nameHint()} 握手超时`);
          resolve(false);this.restart();
        }
      }, HELLO_TIMEOUT_MS);

      rl.on('line', (line) => {
        const msg = decodeLine(line);
        if (!msg) return;
        this.handle(msg, helloTimer, resolve);
      });

      proc.on('exit', (code, signal) => {
        clearTimeout(helloTimer);
        if (!this.stopped) {
          logger.warn('providers', `${this.nameHint()} 退出 code=${code} sig=${signal}`);
          this.restart();
        }
      });
    });
  }

  handle(msg, helloTimer, resolve) {
    if (msg.type === 'hello') {
      const parsed = parseHello(msg);
      if (parsed && parsed.error) {
        logger.error('providers', `${this.nameHint()} 握手失败: ${parsed.error}`);
        resolve(false);this.restart();
        return;
      }
      if(this.allowed&&parsed.capabilities.some(c=>!this.allowed.includes(c))){
        logger.error('providers','plugin capability violates allowlist');
        resolve(false);this.restart();return;
      }
      this.hello=parsed;
      clearTimeout(helloTimer);
      this.startHeartbeat();
      logger.info('providers', `Provider 就绪: ${parsed.provider} (abi=${parsed.abi}, caps=${parsed.capabilities.join(',') || 'none'})`);
      resolve(true);
      return;
    }
    if (!this.hello) return; // 握手前忽略数据
    if (msg.type === 'heartbeat') {
      this.lastHeartbeat = Date.now();
      return;
    }
    if (msg.type === 'observation' && msg.observation) {
      const cap=observationCapability(msg.observation);
      if(cap&&this.hello.capabilities.includes(cap))this.onObservation(msg.observation,{providerId:this.id,provider:this.hello.provider});
      return;
    }
    if (msg.type === 'batch' && Array.isArray(msg.observations)) {
      for (const o of msg.observations) {
        const cap=observationCapability(o);
        if(cap&&this.hello.capabilities.includes(cap))this.onObservation(o,{providerId:this.id,provider:this.hello.provider});
      }
    }
  }

  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        logger.error('providers', `${this.nameHint()} 心跳丢失，重启`);
        this.restart();
      }
    }, 2000);
  }

  restart() {
    if (this.stopped||this.restarting) return;
    this.restarting=true;
    this.restarts += 1;
    if (this.restarts > MAX_RESTARTS) {
      logger.error('providers', `${this.nameHint()} 重启次数超限，放弃`);
      this.stop();
      return;
    }
    logger.info('providers', `重启 ${this.nameHint()} (#${this.restarts})`);
    this.stop(false);
    setTimeout(() => {this.restarting=false;void this.start();}, 1000);
  }

  stop(remove = true) {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
    if (remove) this.mgr.instances.delete(this.id);
  }

  nameHint() {
    const base = this.scriptPath ? this.scriptPath.split(/[\\/]/).pop() : 'unknown';
    return this.hello ? this.hello.provider : base;
  }

  status() {
    return {
      id: this.id,
      provider: this.hello ? this.hello.provider : this.scriptPath,
      abi: this.hello ? this.hello.abi : null,
      capabilities: this.hello ? this.hello.capabilities : [],
      healthy: !!this.hello && Date.now() - this.lastHeartbeat < HEARTBEAT_TIMEOUT_MS,
      restarts: this.restarts,
      startedAt: this.startedAt,
    };
  }
}

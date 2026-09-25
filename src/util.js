// 通用工具：ID 生成、配置读写、凭证存储、日志。

import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';

// ULID 风格 ID：时间戳(ms) + 随机后缀，可排序且全局唯一。
export function genId(prefix = 'id') {
  const t = Date.now().toString(36).toUpperCase();
  const r = randomBytes(6).toString('hex').toUpperCase();
  return `${prefix}_${t}${r}`;
}

export function nowIso() {
  return new Date().toISOString();
}

// ---- 日志 ----
let logLevel = 'info';
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
export function setLogLevel(l) {
  if (LEVELS[l] !== undefined) logLevel = l;
}
export function log(level, tag, ...args) {
  if (LEVELS[level] < LEVELS[logLevel]) return;
  const line = `[${nowIso()}] [${level.toUpperCase()}] [${tag}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
export const logger = {
  debug: (t, ...a) => log('debug', t, ...a),
  info: (t, ...a) => log('info', t, ...a),
  warn: (t, ...a) => log('warn', t, ...a),
  error: (t, ...a) => log('error', t, ...a),
};

// ---- 配置 ----
export function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}

export function loadJson(path, fallback = null) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    logger.warn('util', `读取配置失败 ${path}: ${e.message}`);
  }
  return fallback;
}

export function saveJson(path, obj) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(obj, null, 2), 'utf8');
}

export function loadConfig(path, defaults) {
  return { ...defaults, ...(loadJson(path, {}) || {}) };
}

// ---- 凭证存储 ----
// 设计文档要求 Windows 上使用 DPAPI / Credential Manager。
// 纯 Node 无原生依赖时，退化为「机器盐 + AES-256-GCM」加密本地文件，
// 密钥由机器标识派生；README 说明生产应替换为 DPAPI。
export class CredentialStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.key = scryptSync(machineId(), 'tdf-cred-salt', 32);
  }

  save(records) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plain = Buffer.from(JSON.stringify(records), 'utf8');
    const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    ensureDir(dirname(this.filePath));
    writeFileSync(this.filePath, JSON.stringify({
      v: 1,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: enc.toString('base64'),
    }), 'utf8');
  }

  load() {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(raw.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(raw.tag, 'base64'));
      const dec = Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64')), decipher.final()]);
      return JSON.parse(dec.toString('utf8'));
    } catch {
      return {};
    }
  }
}

function machineId() {
  try {
    const ids = os.networkInterfaces();
    for (const name of Object.keys(ids)) {
      for (const ni of ids[name] || []) {
        if (ni.mac && ni.mac !== '00:00:00:00:00:00') return ni.mac;
      }
    }
  } catch {}
  return os.hostname() + '|' + os.platform();
}

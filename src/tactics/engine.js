// 战术引擎（对应《开发方案》Batch 3：threat/crossfire/isolation/encirclement/
// escape route/supply state/voice priority/TTS debounce）。
// 输入 WorldState，输出结构化态势 + 语音告警队列。

import { logger } from '../util.js';

const THREAT_DIST_NEAR = 25;
const THREAT_DIST_FAR = 80;
const ISOLATION_RADIUS = 40;    // 最近队友 < 40m 不算孤立
const ISOLATION_CENTROID = 60;  // 离队伍质心 < 60m 不算孤立

export class TacticsEngine {
  constructor({ voiceCooldownMs = 3000 } = {}) {
    this.voiceCooldownMs = voiceCooldownMs;
    this.lastSpoken = {}; // category -> timestamp
    this.alerts = []; // 本轮告警
  }

  evaluate(ws) {
    const alerts = [];
    const threats = this._threats(ws, alerts);
    const crossfires = this._crossfire(ws, threats);
    const isolated = this._isolation(ws);
    const encirclement = this._encirclement(ws);
    const escape = this._escapeRoute(ws);
    const supply = this._supply(ws);
    this.alerts = alerts;
    return { threats, crossfires, isolated, encirclement, escape_route: escape, supply, alerts };
  }

  // ---- 威胁评估 ----
  _threats(ws, alerts) {
    const selfPos = ws.self && ws.self.position;
    const out = [];
    for (const e of ws.enemies) {
      if (!e.position || !selfPos) continue;
      const d = Math.hypot(e.position.x - selfPos.x, e.position.y - selfPos.y);
      const level = this._threatLevel(d, e.confidence);
      out.push({
        id: e.id,
        level,
        distance: Math.round(d),
        confidence: e.confidence,
        kind: e.kind,
        source: e.source,
      });
      if (level === 'HIGH' && d < THREAT_DIST_NEAR) {
        this._speak(alerts, 'threat', `近距离高威胁目标，距离约 ${Math.round(d)} 米`);
      }
    }
    out.sort((a, b) => (a.distance - b.distance));
    return out;
  }

  _threatLevel(d, confidence) {
    const base = d < THREAT_DIST_NEAR ? 1 : d < THREAT_DIST_FAR ? 0.6 : 0.3;
    const score = base * (confidence ?? 0.5);
    if (score > 0.7) return 'HIGH';
    if (score > 0.35) return 'MEDIUM';
    return 'LOW';
  }

  // ---- 交叉火力：敌人位于两名队友连线之间（角度接近 180°） ----
  _crossfire(ws, threats) {
    const out = [];
    const team = _teamPositions(ws);
    if (team.length < 2) return out;
    for (const th of threats) {
      const e = ws.enemies.find((x) => x.id === th.id);
      if (!e || !e.position) continue;
      for (let i = 0; i < team.length; i++) {
        for (let j = i + 1; j < team.length; j++) {
          const a = team[i];
          const b = team[j];
          const va = { x: e.position.x - a.position.x, y: e.position.y - a.position.y };
          const vb = { x: e.position.x - b.position.x, y: e.position.y - b.position.y };
          const angle = angleBetween(va, vb);
          if (angle > 150) {
            out.push({ enemy: e.id, between: [a.id, b.id], angle: Math.round(angle) });
          }
        }
      }
    }
    return out;
  }

  // ---- 孤立：队友远离队伍质心或远离所有队友 ----
  _isolation(ws) {
    const team = _teamPositions(ws);
    if (team.length < 2) return [];
    const centroid = centroidOf(team);
    const isolated = [];
    for (const m of team) {
      const dCentroid = Math.hypot(m.position.x - centroid.x, m.position.y - centroid.y);
      const nearest = Math.min(...team.filter((x) => x.id !== m.id).map((x) =>
        Math.hypot(x.position.x - m.position.x, x.position.y - m.position.y)));
      if (dCentroid > ISOLATION_CENTROID || nearest > ISOLATION_RADIUS) {
        isolated.push({ id: m.id, nearest_teammate: Math.round(nearest), from_centroid: Math.round(dCentroid) });
      }
    }
    return isolated;
  }

  // ---- 合围：敌人覆盖队伍质心周围多个扇区 ----
  _encirclement(ws) {
    const selfPos = ws.self && ws.self.position;
    if (!selfPos || ws.enemies.length < 2) return { level: 'NONE', sectors: 0, enemies: 0 };
    const angles = ws.enemies
      .filter((e) => e.position)
      .map((e) => Math.atan2(e.position.y - selfPos.y, e.position.x - selfPos.x));
    const covered = sectorsCovered(angles);
    let level = 'NONE';
    if (covered >= 6) level = 'SURROUNDED';
    else if (covered >= 4) level = 'FLANKED';
    else if (covered >= 2) level = 'PARTIAL';
    return { level, sectors: covered, enemies: angles.length };
  }

  // ---- 撤离路线：远离敌人质心的方向 ----
  _escapeRoute(ws) {
    const selfPos = ws.self && ws.self.position;
    const enemies = ws.enemies.filter((e) => e.position);
    if (!selfPos || enemies.length === 0) return { bearing: null, rationale: 'no_threat' };
    const ec = centroidOf(enemies.map((e) => ({ position: e.position, id: e.id })));
    const dx = selfPos.x - ec.x;
    const dy = selfPos.y - ec.y;
    const bearing = (Math.atan2(dy, dx) * 180) / Math.PI;
    return { bearing: Math.round((bearing + 360) % 360), rationale: 'away_from_enemy_centroid' };
  }

  // ---- 补给状态（ENOUGH/LOW/EMPTY） ----
  _supply(ws) {
    return {
      self: summarizeSupply(ws.self),
      team: Object.fromEntries(Object.entries(ws.teammates).map(([id, t]) => [id, summarizeSupply(t.state)])),
    };
  }

  // ---- 语音优先级 + TTS 防抖 ----
  _speak(alerts, category, text) {
    const now = Date.now();
    const last = this.lastSpoken[category] || 0;
    if (now - last < this.voiceCooldownMs) return;
    this.lastSpoken[category] = now;
    const priority = category === 'threat' ? 'HIGH' : 'MEDIUM';
    alerts.push({ priority, category, text, at: now });
  }
}

function summarizeSupply(state) {
  const hp = state && state.hp !== undefined ? state.hp : (state && state.max_hp) || null;
  const ammo = state && state.ammo;
  const medkits = state && state.medkits;
  const status = {};
  if (hp !== null) status.health = hp <= 25 ? 'EMPTY' : hp <= 50 ? 'LOW' : 'ENOUGH';
  if (ammo !== undefined) status.ammo = ammo <= 0 ? 'EMPTY' : ammo <= 30 ? 'LOW' : 'ENOUGH';
  if (medkits !== undefined) status.medkits = medkits <= 0 ? 'EMPTY' : medkits <= 1 ? 'LOW' : 'ENOUGH';
  return status;
}

function _teamPositions(ws) {
  const team = [];
  if (ws.self && ws.self.position) team.push({ id: ws.self.id || 'self', position: ws.self.position });
  for (const [id, t] of Object.entries(ws.teammates)) {
    if (t.position) team.push({ id, position: t.position });
  }
  return team;
}

function centroidOf(list) {
  const c = { x: 0, y: 0 };
  for (const p of list) { c.x += p.position.x; c.y += p.position.y; }
  c.x /= list.length;
  c.y /= list.length;
  return c;
}

function angleBetween(a, b) {
  const dot = a.x * b.x + a.y * b.y;
  const ma = Math.hypot(a.x, a.y);
  const mb = Math.hypot(b.x, b.y);
  if (ma === 0 || mb === 0) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, dot / (ma * mb)))) * 180) / Math.PI;
}

// 敌人方位覆盖的扇区数（8 扇区）
function sectorsCovered(angles) {
  const sectors = new Set();
  for (const a of angles) {
    const deg = ((a * 180) / Math.PI + 360) % 360;
    sectors.add(Math.floor(deg / 45));
  }
  return sectors.size;
}

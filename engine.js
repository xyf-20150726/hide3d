'use strict';
/**
 * 惊魂躲猫猫 3D —— 联机服务端
 * 启动：node server.js  → 浏览器打开 http://localhost:3000
 */

// ---------- 全局规则 ----------
const ARENA = 20;              // 场地半径（正方形半边长，40×40 米）
const PREPARE_TIME = 15;   // 准备阶段秒数
const PLAY_TIME = 150;         // 对局秒数
const TICK = 50;               // 20Hz
const MAX_PER_TEAM = 4;        // 每队上限
const ENERGY_NEAR = 5.5;       // 多近开始攒能量
const ENERGY_RATE = 0.55;      // 每 tick 增长（约 9 秒充满）
const TAUNT_NEAR = 20;         // 20 米内有调查员才能嘲讽
const TAUNT_ENERGY = 12;       // 嘲讽一次加的能量
const POUNCE_RANGE = 3.4;      // 扑咬判定半径
const SHOOT_RANGE = 26;        // 射击最大距离
const ITEM_RESPAWN = 20000;    // 道具重生毫秒
const CABINET_ITEM_CHANCE = 0.65; // 每个柜子里有东西的概率
const OPEN_RANGE = 2.2;        // 离柜子多近能打开
const TAUNT_CD = 3500;         // 嘲讽冷却（毫秒）
const TAUNT_TIME = 3500;       // 嘲讽持续暴露 3.5 秒
const DECOY_CD = 12000;        // 诱饵冷却（毫秒）
const MAX_DECOYS = 24;         // 全房间同时存在的诱饵上限
const MAX_BULLETS = 3;         // 调查员最多带 3 发
const AMMO_REGEN = 6000;       // 每 6 秒自动补 1 发
const POUNCE_TIME = 600;       // 扑咬全过程（毫秒）：先蓄力再冲出去
const POUNCE_DASH = 8.5;       // 扑咬冲刺速度（米/秒）
const MAX_Y = 3.6;             // 跳跃最高点（能跳上箱子再跳一次）

// ---------- 地图生成（服务端权威，客户端只渲染） ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROP_TYPES = ['crate', 'barrel', 'bucket', 'cart', 'plant', 'chair', 'trash', 'tank'];
const PROP_SIZE = {
  crate: { w: 1.0, d: 1.0, h: 1.0 },
  barrel: { w: 0.9, d: 0.9, h: 1.2 },
  bucket: { w: 0.8, d: 0.8, h: 0.8 },
  cart: { w: 1.7, d: 1.0, h: 0.95 },
  plant: { w: 0.8, d: 0.8, h: 1.1 },
  chair: { w: 0.8, d: 0.8, h: 1.0 },
  trash: { w: 0.7, d: 0.7, h: 1.0 },
  tank: { w: 0.6, d: 0.6, h: 1.15 }
};

// 沿一条直线砌墙，可留出门洞 gaps = [{at, w}]
function addWallLine(walls, x1, z1, x2, z2, gaps, height) {
  const h = height || 3.0;
  const horiz = Math.abs(z2 - z1) < 0.01;
  const a = horiz ? Math.min(x1, x2) : Math.min(z1, z2);
  const b = horiz ? Math.max(x1, x2) : Math.max(z1, z2);
  const fixed = horiz ? z1 : x1;

  const emit = (s, e) => {
    if (e - s < 0.4) return;
    if (horiz) walls.push({ x: (s + e) / 2, z: fixed, w: e - s, d: 0.5, h, kind: 'wall' });
    else walls.push({ x: fixed, z: (s + e) / 2, w: 0.5, d: e - s, h, kind: 'wall' });
  };

  let cursor = a;
  for (const g of (gaps || []).slice().sort((p, q) => p.at - q.at)) {
    const s = Math.max(a, g.at - g.w / 2);
    const e = Math.min(b, g.at + g.w / 2);
    if (s > cursor) emit(cursor, s);
    cursor = Math.max(cursor, e);
  }
  if (cursor < b) emit(cursor, b);
}

function makeMap() {
  const rnd = mulberry32(20261121);
  const walls = [];   // 障碍物（碰撞 + 遮挡视线）

  // 出生点（先定义，道具要避开）
  const hideSpawns = [{ x: -16, z: -16 }, { x: -16, z: -14.5 }, { x: -14.5, z: -16 }, { x: -17.5, z: -17.5 }];
  const huntSpawns = [{ x: 16, z: 16 }, { x: -16, z: 16 }, { x: 16, z: -16 }, { x: 0, z: -16 }];
  const spawnPoints = hideSpawns.concat(huntSpawns);

  const D = 2.4;      // 门洞宽度
  const COR = 2.5;    // 十字走廊半宽
  const SPLIT = 11.25;// 象限内部隔断位置

  // ---- 外墙（封闭）----
  addWallLine(walls, -ARENA, -ARENA, ARENA, -ARENA, [], 3.6);
  addWallLine(walls, -ARENA, ARENA, ARENA, ARENA, [], 3.6);
  addWallLine(walls, -ARENA, -ARENA, -ARENA, ARENA, [], 3.6);
  addWallLine(walls, ARENA, -ARENA, ARENA, ARENA, [], 3.6);

  // ---- 十字走廊的四面隔墙（各留门洞，中间 x=0/z=0 也要开门让十字贯通）----
  for (const sx of [-COR, COR]) {
    addWallLine(walls, sx, -ARENA, sx, ARENA,
      [{ at: -14, w: D }, { at: -7, w: D }, { at: 0, w: D }, { at: 7, w: D }, { at: 14, w: D }], 3.0);
  }
  for (const sz of [-COR, COR]) {
    addWallLine(walls, -ARENA, sz, ARENA, sz,
      [{ at: -14, w: D }, { at: -7, w: D }, { at: 0, w: D }, { at: 7, w: D }, { at: 14, w: D }], 3.0);
  }

  // ---- 每个象限切成 2 间（共 8 间），门各开一个 ----
  for (const qx of [-1, 1]) {
    for (const qz of [-1, 1]) {
      addWallLine(walls, qx * SPLIT, qz < 0 ? -ARENA : COR, qx * SPLIT, qz < 0 ? -COR : ARENA,
        [{ at: qz * 6.5, w: D }, { at: qz * 15.5, w: D }], 3.0);
    }
  }

  // ---- 东西走廊尽头再各隔出 1 间小屋（共 10 间）----
  for (const ex of [-16.5, 16.5]) {
    addWallLine(walls, ex, -COR, ex, COR, [{ at: 0, w: D }], 3.0);
  }

  // 走廊中央的柱子（少量装饰性掩体）
  for (const sx of [-COR - 0.9, COR + 0.9]) {
    for (const sz of [-COR - 0.9, COR + 0.9]) {
      walls.push({ x: sx, z: sz, w: 0.9, d: 0.9, h: 3.2, kind: 'pillar' });
    }
  }

  // 可移动掩体 / 伪装道具本体
  const props = [];
  let guard = 0;
  while (props.length < 52 && guard++ < 900) {
    const type = PROP_TYPES[Math.floor(rnd() * PROP_TYPES.length)];
    const s = PROP_SIZE[type];
    const x = (rnd() * 2 - 1) * (ARENA - 1.6);
    const z = (rnd() * 2 - 1) * (ARENA - 1.6);
    const rot = rnd() * Math.PI * 2;
    // 避开出生点 4.5 米内
    let nearSpawn = false;
    for (const sp of spawnPoints) {
      if (Math.hypot(x - sp.x, z - sp.z) < 4.5) { nearSpawn = true; break; }
    }
    if (nearSpawn) continue;
    // 避开已有道具 1.7 米内，防止叠在一起
    let crowded = false;
    for (const p0 of props) {
      if (Math.hypot(x - p0.x, z - p0.z) < 1.7) { crowded = true; break; }
    }
    if (crowded) continue;
    // 不要压着墙 / 柱子
    let onWall = false;
    for (const w of walls) {
      if (Math.abs(x - w.x) < (w.w / 2 + s.w / 2 + 0.4) && Math.abs(z - w.z) < (w.d / 2 + s.d / 2 + 0.4)) { onWall = true; break; }
    }
    if (onWall) continue;

    const box = { x, z, w: s.w, d: s.d, h: s.h, kind: 'prop', propType: type, rot };
    walls.push(box);
    props.push(box);
  }

  // 柜子刷新点：一局固定 5 个柜子，道具藏在柜子里（也可能被翻空）
  const cabinetSpots = [
    { x: -8, z: -4 }, { x: 8, z: 4 }, { x: -16, z: 16 }, { x: 16, z: -16 }, { x: -4, z: 14 }
  ];

  return { walls, props, cabinetSpots, hideSpawns, huntSpawns, arena: ARENA };
}

const MAP = makeMap();

// ---------- 射线 vs AABB（视线遮挡判定） ----------
function rayBox(ox, oy, oz, dx, dy, dz, box) {
  const hx = box.w / 2, hz = box.d / 2;
  const minx = box.x - hx, maxx = box.x + hx;
  const miny = 0, maxy = box.h;
  const minz = box.z - hz, maxz = box.z + hz;
  let tmin = 0, tmax = Infinity;

  const axes = [
    [ox, dx, minx, maxx],
    [oy, dy, miny, maxy],
    [oz, dz, minz, maxz]
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-8) {
      if (o < lo || o > hi) return null;
    } else {
      let t1 = (lo - o) / d, t2 = (hi - o) / d;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

// ---------- 房间 / 玩家 ----------
let nextPid = 1;
const rooms = new Map();

// 每局随机：5 个柜子，里面可能是探测仪 / 护身符，也可能是空的
function rollCabinets() {
  const list = MAP.cabinetSpots.map((s, i) => ({ id: i, x: s.x, z: s.z, item: null, respawnAt: 0 }));
  let filled = 0;
  for (const c of list) {
    if (Math.random() < CABINET_ITEM_CHANCE) {
      c.item = Math.random() < 0.55 ? 'detector' : 'shield';
      filled++;
    }
  }
  // 至少留 2 个有东西的柜子，不然一局白翻
  while (filled < 2) {
    const empty = list.find(c => !c.item);
    if (!empty) break;
    empty.item = Math.random() < 0.55 ? 'detector' : 'shield';
    filled++;
  }
  return list;
}

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      players: new Map(),
      phase: 'lobby',        // lobby | prepare | playing | rage | end
      timer: PREPARE_TIME + PLAY_TIME,
      cabinets: rollCabinets(),
      decoys: [],
      winner: null,
      botFill: 4,            // 人机补位：每队补到几人（0 = 关闭）
      asymFill: false,       // 1v4 模式：自己这边不补人机，对面补满
      teamSize: 4,           // 对局规模：每队几人（2v2 / 3v3 / 4v4）
      endText: ''
    });
  }
  return rooms.get(code);
}

function makeState(room, viewerTeam) {
  const players = [];
  // 准备阶段：调查员还看不见躲藏者，等躲好了（进入游玩阶段）才现身
  const hideHidden = room.phase === 'prepare' && viewerTeam === 'hunt';
  for (const p of room.players.values()) {
    if (hideHidden && p.team === 'hide') {
      players.push({ i: p.id, n: p.name, team: p.team, a: p.alive ? 1 : 0, inh: 1 });
      continue;
    }
    players.push({
      i: p.id, n: p.name, team: p.team,
      x: +p.x.toFixed(2), y: +(p.y || 0).toFixed(2), z: +p.z.toFixed(2),
      ry: +(p.ry || 0).toFixed(2),
      a: p.alive ? 1 : 0,
      hid: p.hiding ? 1 : 0,
      m: p.hiding ? PROP_TYPES.indexOf(p.model) : -1,
      en: Math.round(p.energy),
      bu: p.bullets,
      sh: p.hasShield ? 1 : 0,
      rg: p.rage ? 1 : 0,
      prep: p.pref || 'random',
      host: p.host ? 1 : 0,
      spec: p.spectator ? 1 : 0,
      bot: p.isBot ? 1 : 0,
      pb: p.pouncing ? 1 : 0,
      tc: Math.max(0, TAUNT_CD - (Date.now() - (p.tauntAt || 0))),
      dc: Math.max(0, DECOY_CD - (Date.now() - (p.decoyAt || 0)))
    });
  }
  return {
    t: 'state',
    phase: room.phase,
    timer: Math.max(0, Math.ceil(room.timer)),
    items: [],
    cabinets: room.cabinets.map(c => ({ i: c.id, x: c.x, z: c.z })),
    decoys: room.decoys.map(d => [ +d.x.toFixed(1), +d.z.toFixed(1) ]),
    players,
    winner: room.winner
  };
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  const raw = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(raw);
  }
}

// 状态按队伍分别下发：准备阶段调查员看不到躲藏者
function broadcastState(room) {
  const cache = new Map();
  for (const p of room.players.values()) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    const key = p.team === 'hunt' && room.phase === 'prepare' ? 'hunt' : 'all';
    if (!cache.has(key)) cache.set(key, JSON.stringify(makeState(room, key === 'hunt' ? 'hunt' : p.team)));
    p.ws.send(cache.get(key));
  }
}

function broadcastLobby(room) {  broadcast(room, {
    t: 'lobby',
    code: room.code,
    phase: room.phase,
    fill: room.botFill,
    asym: room.asymFill ? 1 : 0,
    size: room.teamSize,
    players: [...room.players.values()].filter(p => !p.isBot).map(p => ({
      i: p.id, n: p.name, host: p.host ? 1 : 0, pref: p.pref
    }))
  });
}

function event(room, text, kind = 'info') {
  broadcast(room, { t: 'event', kind, text });
}

// 房间列表（供客户端选择和加入）
function roomList() {
  const list = [];
  for (const room of rooms.values()) {
    const humans = [...room.players.values()].filter(p => !p.isBot && p.ws && p.ws.readyState === 1);
    list.push({
      code: room.code,
      humans: humans.length,
      phase: room.phase,
      fill: room.botFill,
      size: room.teamSize,
      full: humans.length >= room.teamSize * 2,
      idle: room.touched || Date.now()
    });
  }
  return list.sort((a, b) => (b.humans - a.humans) || (a.code > b.code ? 1 : -1)).slice(0, 24);
}

function clampPos(p) {
  p.x = Math.min(ARENA - 0.6, Math.max(-ARENA + 0.6, p.x));
  p.z = Math.min(ARENA - 0.6, Math.max(-ARENA + 0.6, p.z));
}

// 是否有墙挡住射线
function blocked(ox, oy, oz, dx, dy, dz, maxT) {
  let nearest = maxT;
  for (const w of MAP.walls) {
    if (w.kind === 'prop') continue;   // 小型道具不挡子弹，只挡视线略过（简化）
    const t = rayBox(ox, oy, oz, dx, dy, dz, w);
    if (t !== null && t > 0.05 && t < nearest) nearest = t;
  }
  return nearest < maxT ? nearest : null;
}

// 射线与玩家命中（近似为竖直圆柱）
// maxHy = 命中高度上限（相对地面）。站在物品上开枪时，上限随脚下高度一起抬高
function rayPlayer(ox, oy, oz, dx, dy, dz, p, radius, maxHy) {
  const cap = (typeof maxHy === 'number' ? maxHy : 1.6);
  // 在 XZ 平面与半径 radius 的圆判交，同时 y 不超过上限
  const px = p.x - ox, pz = p.z - oz;
  const proj = px * dx + pz * dz;
  if (proj <= 0) return null;
  const distSq = px * px + pz * pz - proj * proj;
  if (distSq > radius * radius) return null;
  const t = proj;
  const hy = oy + dy * t;
  if (hy < -0.3 || hy > cap) return null;   // 默认最多打到 1.6 米高
  return t;
}

// ---------- 人机（AI 补位） ----------
const BOT_NAMES = ['阿呆', '小呆', '憨憨', '铁蛋', '豆子', '球球', '毛毛', '阿柴'];

// 点位是否被障碍物占住
function blockedPoint(x, z, r) {
  for (const w of MAP.walls) {
    if (Math.abs(x - w.x) < w.w / 2 + r && Math.abs(z - w.z) < w.d / 2 + r) return true;
  }
  return false;
}

// 躲藏者：找一个和自己同款的道具，贴着它站，看着就像多了一个杂物
function blendSpot(b) {
  const same = MAP.props.filter(p => p.kind === 'prop' && p.propType === b.model);
  if (!same.length) return pickWaypoint();
  const near = same
    .map(p => ({ p, d: Math.hypot(p.x - b.x, p.z - b.z) }))
    .filter(o => o.d > 2 && o.d < 26)
    .sort((a, c) => a.d - c.d);
  const pick = near.length ? near[Math.floor(Math.random() * Math.min(3, near.length))].p : same[0];
  for (let i = 0; i < 8; i++) {
    const ang = Math.random() * Math.PI * 2;
    const x = pick.x + Math.sin(ang) * (pick.w / 2 + 0.7);
    const z = pick.z + Math.cos(ang) * (pick.d / 2 + 0.7);
    if (!blockedPoint(x, z, 0.42)) return { x, z };
  }
  return pickWaypoint();
}

function pickWaypoint() {
  if (!WALK) buildWalkGrid();
  for (let i = 0; i < 80; i++) {
    const c = Math.floor(Math.random() * WALK.length);
    if (!WALK[c]) continue;
    return { x: GRID_MIN + (c % GRID_N), z: GRID_MIN + Math.floor(c / GRID_N) };
  }
  return { x: 0, z: 0 };
}

// 找一个离某人至少 minD 米的落脚点（躲藏者听到调查员靠近时换位用）
function pickWaypointFar(from, minD) {
  for (let i = 0; i < 60; i++) {
    const w = pickWaypoint();
    if (!from || Math.hypot(w.x - from.x, w.z - from.z) >= minD) return w;
  }
  return pickWaypoint();
}

// ---------- 网格寻路（1 米一格，BFS） ----------
const GRID_N = ARENA * 2 + 1;
const GRID_MIN = -ARENA;
let WALK = null;

function buildWalkGrid() {
  WALK = new Uint8Array(GRID_N * GRID_N);
  for (let j = 0; j < GRID_N; j++) {
    for (let i = 0; i < GRID_N; i++) {
      const x = GRID_MIN + i, z = GRID_MIN + j;
      WALK[j * GRID_N + i] = blockedPoint(x, z, 0.42) ? 0 : 1;
    }
  }
}

function cellIdx(v) {
  return Math.max(0, Math.min(GRID_N - 1, Math.round((v - GRID_MIN))));
}

function nearestWalkable(cell) {
  if (WALK[cell]) return cell;
  const cx = cell % GRID_N, cy = Math.floor(cell / GRID_N);
  let best = -1, bestD = Infinity;
  for (let r = 1; r <= 10; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;  // 只看最外圈
        const nx = cx + dx, ny = cy + dz;
        if (nx < 0 || ny < 0 || nx >= GRID_N || ny >= GRID_N) continue;
        const ni = ny * GRID_N + nx;
        if (!WALK[ni]) continue;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = ni; }
      }
    }
    if (best >= 0) return best;
  }
  return best;
}

function findPath(sx, sz, tx, tz) {
  if (!WALK) buildWalkGrid();
  const N = GRID_N;
  let s = cellIdx(sz) * N + cellIdx(sx);
  let g = cellIdx(tz) * N + cellIdx(tx);
  if (!WALK[s]) s = nearestWalkable(s);
  if (!WALK[g]) g = nearestWalkable(g);
  if (s < 0 || g < 0 || s === g) return [];

  const prev = new Int32Array(N * N).fill(-1);
  const queue = [s];
  prev[s] = s;
  let head = 0;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  while (head < queue.length) {
    const cur = queue[head++];
    if (cur === g) break;
    const cx = cur % N, cy = Math.floor(cur / N);
    for (const [dx, dz] of DIRS) {
      const nx = cx + dx, ny = cy + dz;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const ni = ny * N + nx;
      if (!WALK[ni] || prev[ni] !== -1) continue;
      prev[ni] = cur;
      queue.push(ni);
    }
  }
  if (prev[g] === -1) return [];

  const path = [];
  let cur = g, guard = 0;
  while (cur !== s && guard++ < N * N) {
    path.push({ x: GRID_MIN + (cur % N), z: GRID_MIN + Math.floor(cur / N) });
    cur = prev[cur];
  }
  return path.reverse();
}

// 沿寻路结果移动
function botFollow(bot, tx, tz, dt, speed) {
  const bs = bot.bot;
  bs.pathCd -= dt;
  const goalChanged = !bs.goal || Math.hypot(bs.goal.x - tx, bs.goal.z - tz) > 2.5;
  if (goalChanged || bs.pathCd <= 0 || !bs.path) {
    bs.path = findPath(bot.x, bot.z, tx, tz);
    bs.pathIdx = 0;
    bs.goal = { x: tx, z: tz };
    bs.pathCd = 1.1;
  }
  if (!bs.path || bs.path.length === 0) {
    // 先挪回最近的可行走格（防止站在墙边永远算不出路）
    const cc = nearestWalkable(cellIdx(bot.z) * GRID_N + cellIdx(bot.x));
    if (cc >= 0) {
      const cxw = GRID_MIN + (cc % GRID_N), czw = GRID_MIN + Math.floor(cc / GRID_N);
      const ddx = cxw - bot.x, ddz = czw - bot.z, dd = Math.hypot(ddx, ddz);
      if (dd > 0.15) {
        const st = Math.min(speed * dt, dd);
        const nx0 = bot.x + (ddx / dd) * st, nz0 = bot.z + (ddz / dd) * st;
        if (!blockedPoint(nx0, nz0, 0.3)) { bot.x = nx0; bot.z = nz0; return; }
      }
    }
    // 直线凑近（没有可达路径时）
    const dx = tx - bot.x, dz = tz - bot.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.3) {
      const nx = bot.x + (dx / d) * Math.min(speed * dt, d);
      const nz = bot.z + (dz / d) * Math.min(speed * dt, d);
      if (!blockedPoint(nx, nz, 0.42)) { bot.x = nx; bot.z = nz; }
    }
    return;
  }
  while (bs.pathIdx < bs.path.length - 1) {
    const n = bs.path[bs.pathIdx];
    if (Math.hypot(n.x - bot.x, n.z - bot.z) < 0.55) bs.pathIdx++;
    else break;
  }
  const node = bs.path[bs.pathIdx];
  if (!node) { bs.path = null; bs.pathCd = 0; return; }
  let dx = node.x - bot.x, dz = node.z - bot.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-4) { bs.pathIdx++; return; }
  dx /= d; dz /= d;
  const step = Math.min(speed * dt, d);
  let nx = bot.x + dx * step, nz = bot.z + dz * step;
  if (blockedPoint(nx, nz, 0.42)) {
    // 被墙角卡住时：只沿单一轴滑动，实在不行就跳过这个路径点
    if (!blockedPoint(bot.x + dx * step, bot.z, 0.42)) { nz = bot.z; }
    else if (!blockedPoint(bot.x, bot.z + dz * step, 0.42)) { nx = bot.x; }
    else { bs.pathIdx++; return; }
  }
  bot.x = nx;
  bot.z = nz;
  bot.ry = Math.atan2(-dx, -dz);
}

function makeBot(room, team, seq, spawn) {
  const id = nextPid++;
  const name = '🤖' + BOT_NAMES[seq % BOT_NAMES.length] + (seq >= BOT_NAMES.length ? seq + 1 : '');
  const bot = {
    ws: null, isBot: true, id, name,
    pref: team, host: false,
    x: spawn.x, z: spawn.z, ry: 0,
    team, alive: true,
    hiding: team === 'hide',
    model: PROP_TYPES[seq % PROP_TYPES.length],
    energy: 0, bullets: team === 'hunt' ? MAX_BULLETS : 0,
    hasShield: false, rage: false, spectator: false,
    bot: { wp: null, shootCd: 0.4, tauntCd: 1.5, reloadAt: 0, jitter: Math.random() * 10,
           path: null, pathIdx: 0, pathCd: 0, goal: null, lastKey: -1, spot: false }
  };
  room.players.set(id, bot);
  return bot;
}

function removeBots(room) {
  for (const p of [...room.players.values()]) {
    if (p.isBot) room.players.delete(p.id);
  }
}

// 调查员机器人走到柜子旁边会翻柜子
// 打开柜子：返回 'detector' / 'shield' / 'empty' / null
function openCabin(room, p, id) {
  if (p.team !== 'hunt' || !p.alive) return null;
  const cab = room.cabinets.find(c => c.id === id);
  if (!cab) return null;
  if (Math.hypot(p.x - cab.x, p.z - cab.z) > OPEN_RANGE) return null;
  const now = Date.now();
  if (p.cabAt && now - p.cabAt < 500) return null;
  p.cabAt = now;
  if (!cab.item) return 'empty';
  const type = cab.item;
  cab.item = null;
  cab.respawnAt = now + ITEM_RESPAWN;
  if (type === 'shield') p.hasShield = true;
  return type;
}

function openNearbyCabinet(room, b) {
  for (const c of room.cabinets) {
    if (!c.item) continue;
    if (Math.hypot(c.x - b.x, c.z - b.z) > OPEN_RANGE) continue;
    if (c.item === 'detector') {
      const hides = [...room.players.values()].filter(q => q.team === 'hide' && q.alive);
      const near = hides.sort((m, n) => Math.hypot(m.x - b.x, m.z - b.z) - Math.hypot(n.x - b.x, n.z - b.z))[0];
      if (near) b.bot.lastSeen = { x: near.x, z: near.z, at: Date.now() };
    } else {
      b.hasShield = true;
    }
    c.item = null;
    c.respawnAt = Date.now() + ITEM_RESPAWN;
    return true;
  }
  return false;
}

// 每 tick 更新所有机器人
function updateBots(room) {
  const dt = TICK / 1000;
  const all = [...room.players.values()];

  for (const b of all) {
    if (!b.isBot || !b.alive) continue;
    if (b.pouncing) continue;   // 扑咬过程中由服务端控制冲刺
    if (room.phase === 'prepare' && b.team === 'hunt') continue; // 准备阶段调查员原地等待

    if (b.team === 'hide') {
      // 只有站定不动时才算伪装好；移动中会露出本体（否则看起来像道具在滑行，一眼被抓）
      if (b.rage) b.hiding = false;

      const hunters = all.filter(q => q.team === 'hunt' && q.alive);
      const nearestHunter = hunters.length
        ? hunters.reduce((a, c) => (Math.hypot(c.x - b.x, c.z - b.z) < Math.hypot(a.x - b.x, a.z - b.z) ? c : a))
        : null;
      const distHunter = nearestHunter ? Math.hypot(nearestHunter.x - b.x, nearestHunter.z - b.z) : Infinity;

      // 有没有被最近的调查员直视
      const los = (h) => {
        const dx = h.x - b.x, dz = h.z - b.z;
        const d = Math.hypot(dx, dz) || 1;
        return blocked(h.x, 1.45, h.z, dx / d, -0.15, dz / d, d) === null;
      };
      const hunterSeesMe = nearestHunter ? los(nearestHunter) : false;

      b.bot.tauntCd -= dt;
      // 嘲讽会暴露位置：只在没被看见、且 20 米内有调查员时偶尔嘲讽
      if (!b.rage && nearestHunter && distHunter < TAUNT_NEAR && !hunterSeesMe && b.bot.tauntCd <= 0 && Math.random() < 0.3) {
        b.energy = Math.min(100, b.energy + TAUNT_ENERGY);
        b.tauntUntil = Date.now() + TAUNT_TIME;
        b.bot.tauntCd = TAUNT_CD / 1000 + 0.5 + Math.random();
      }

      // 机器人偶尔放诱饵（同样受冷却限制）
      if (!b.rage && Date.now() - (b.decoyAt || 0) > DECOY_CD && Math.random() < 0.015) {
        b.decoyAt = Date.now();
        room.decoys.push({ x: b.x, z: b.z, expire: Date.now() + 12000, owner: b.id });
        while (room.decoys.length > MAX_DECOYS) room.decoys.shift();
      }

      // 躲藏者 AI：会贴着同款道具站、被直视时定住不动、被发现太近就溜、满能量再偷袭

      // 只扑"落单"的调查员，避免一群人的时候送人头
      const nearHunters = hunters.filter(h => Math.hypot(h.x - b.x, h.z - b.z) < 10);
      if ((b.rage || b.energy >= 100) && nearHunters.length === 1 && distHunter <= POUNCE_RANGE) {
        doPounce(room, b);
      } else if ((b.rage || b.energy >= 100) && nearHunters.length === 1 && distHunter <= 12) {
        // 落单目标才贴近，等距离够近再咬
        botFollow(b, nearestHunter.x, nearestHunter.z, dt, b.rage ? 5.4 : 4.3);
        b.bot.wp = null;
      } else if (!b.rage && b.energy >= 100 && distHunter > 12) {
        // 有多人时先找地方蹲着，别冲
        if (!b.bot.wp) b.bot.wp = blendSpot(b);
        botFollow(b, b.bot.wp.x, b.bot.wp.z, dt, 3.2);
      } else if (!b.rage && hunterSeesMe && distHunter < 5.0) {
        // 贴太近被盯着了：往反方向溜，找墙躲视线
        const ax = b.x - nearestHunter.x, az = b.z - nearestHunter.z;
        const d = Math.hypot(ax, az) || 1;
        botFollow(b, b.x + (ax / d) * 6, b.z + (az / d) * 6, dt, 4.6);
        b.bot.wp = null;
      } else if (!b.rage && hunterSeesMe && distHunter < 9) {
        // 在视野里但还有点距离：别动，伪装的道具不会动
        // 只微调朝向，不产生位移
      } else if (!b.rage && distHunter < 6) {
        // 调查员摸过来了（哪怕没看见我）：悄悄换个远点的落脚点
        if (!b.bot.fleeWp || Math.hypot(b.bot.fleeWp.x - b.x, b.bot.fleeWp.z - b.z) < 1.2) {
          b.bot.fleeWp = pickWaypointFar(nearestHunter, 14);
        }
        b.bot.wp = b.bot.fleeWp;
        b.bot.dwellUntil = 0;
        botFollow(b, b.bot.fleeWp.x, b.bot.fleeWp.z, dt, 3.4);
      } else {
        b.bot.fleeWp = null;
        const nowMs = Date.now();
        // 走到点就蹲住不动（伪装生效），蹲 4~9 秒再换点
        const arrived = b.bot.wp && Math.hypot(b.bot.wp.x - b.x, b.bot.wp.z - b.z) < 0.8;
        if (arrived) {
          b.bot.wp = null;
          if (!b.bot.dwellUntil) b.bot.dwellUntil = nowMs + 8000 + Math.random() * 6000;
        }
        const dwelling = b.bot.dwellUntil && nowMs < b.bot.dwellUntil;
        if (!dwelling) {
          b.bot.dwellUntil = 0;
          if (!b.bot.wp) b.bot.wp = b.rage ? pickWaypoint() : blendSpot(b);
          botFollow(b, b.bot.wp.x, b.bot.wp.z, dt, b.rage ? 4.6 : 3.0);
        }
      }
      // 走到位了就蹲稳伪装，还在走就露出本体
      if (!b.rage) {
        const still = !b.bot.wp || Math.hypot(b.bot.wp.x - b.x, b.bot.wp.z - b.z) < 0.5;
        b.hiding = still;
      }
    } else {
      // 调查员机器人：准备阶段原地待命
      if (room.phase === 'prepare') continue;

      b.bot.shootCd -= dt;

      const hides = all.filter(q => q.team === 'hide' && q.alive && q.inh !== 1);
      let target = null;
      if (hides.length) {
        // 「发现」要满足视线 + 距离 + 伪装状态，避免人机全知全能
        const key = Math.floor((Date.now() + b.bot.jitter * 1000) / 3000);
        if (b.bot.lastKey !== key) {
          b.bot.lastKey = key;
          const cand = hides.filter(h => {
            const d = Math.hypot(h.x - b.x, h.z - b.z);
            if (d > 6) return false;
            const dx = h.x - b.x, dy = 1.15 - 1.45, dz = h.z - b.z;
            const len = Math.hypot(dx, dy, dz) || 1;
            if (blocked(b.x, 1.45, b.z, dx / len, dy / len, dz / len, len) !== null) return false;
            // 伪装好并且不动的，混在道具里，远距离认不出来
            if (h.hiding && d > 2.5) return false;
            return true;
          });
          b.bot.spot = (cand.length && Math.random() < 0.4)
            ? cand.reduce((a, c) => (Math.hypot(c.x - b.x, c.z - b.z) < Math.hypot(a.x - b.x, a.z - b.z) ? c : a))
            : null;
        }
        if (b.bot.spot && b.bot.spot.alive && b.bot.spot.inh !== 1) {
          target = b.bot.spot;
          b.bot.lastSeen = { x: target.x, z: target.z, at: Date.now() };
        }
      }

      // 正在嘲讽的躲藏者会暴露 3.5 秒：附近（9 米内）的人机调查员循声过去
      const taunters = hides.filter(h => (h.tauntUntil || 0) > Date.now() && Math.hypot(h.x - b.x, h.z - b.z) < 9);
      if (taunters.length && !target) {
        target = taunters.reduce((a, c) => (Math.hypot(c.x - b.x, c.z - b.z) < Math.hypot(a.x - b.x, a.z - b.z) ? c : a));
        b.bot.lastSeen = { x: target.x, z: target.z, at: Date.now() };
      }

      // 经过柜子就翻开找道具
      if (openNearbyCabinet(room, b)) target = null;

      if (target) {
        const dist = Math.hypot(target.x - b.x, target.z - b.z);
        if (dist > 3.0) botFollow(b, target.x, target.z, dt, 3.2);

        if (b.bullets > 0 && b.bot.shootCd <= 0 && dist < 10 && (!target.hiding || dist < 4)) {
          const o = [b.x, 1.45, b.z];
          const aimX = target.x - b.x, aimY = 1.1 - 1.45, aimZ = target.z - b.z;
          const len = Math.hypot(aimX, aimY, aimZ) || 1;
          const dxn = aimX / len, dyn = aimY / len, dzn = aimZ / len;
          // 视线无遮挡 + 瞄准误差
          if (blocked(o[0], o[1], o[2], dxn, dyn, dzn, dist) === null) {
            const spread = 0.2 * Math.min(1, dist / 12);
            doShoot(room, b,
              o,
              [dxn + (Math.random() - 0.5) * spread, dyn, dzn + (Math.random() - 0.5) * spread]);
            b.bot.shootCd = 1.6 + Math.random() * 1.0;
          }
        }
      } else if (b.bot.lastSeen && Date.now() - b.bot.lastSeen.at < 4000) {
        // 刚看到过目标，追过去继续找
        botFollow(b, b.bot.lastSeen.x, b.bot.lastSeen.z, dt, 3.4);
      } else {
        if (!b.bot.wp || Math.hypot(b.bot.wp.x - b.x, b.bot.wp.z - b.z) < 0.8) {
          // 一半时间直奔柜子，一半时间随便逛
          const loose = room.cabinets.filter(c => c.item);
          if (loose.length && Math.random() < 0.5) {
            const c = loose[Math.floor(Math.random() * loose.length)];
            b.bot.wp = { x: c.x, z: c.z };
          } else b.bot.wp = pickWaypoint();
        }
        botFollow(b, b.bot.wp.x, b.bot.wp.z, dt, 3.2);
      }
    }
  }
}

// ---------- 行为（玩家与人机共用） ----------
// 扑咬分三步：起跳蓄力 → 冲刺 → 到点判定（这 0.6 秒里躲藏者会真的朝前冲出去）
function doPounce(room, attacker) {
  if (attacker.team !== 'hide' || !attacker.alive || attacker.pouncing) return false;
  if (room.phase === 'prepare') return false;   // 准备阶段还没开打
  // 狂暴阶段能量无限：不需要攒满，扑完还能立刻再扑
  if (!attacker.rage && attacker.energy < 100) return false;
  attacker.energy = attacker.rage ? 100 : 0;
  attacker.hiding = false;
  attacker.pouncing = true;
  attacker.pEndAt = Date.now() + POUNCE_TIME;
  const ry = attacker.ry || 0;
  attacker.pdx = -Math.sin(ry);
  attacker.pdz = -Math.cos(ry);
  attacker.py = 0;
  // 通知所有人播放扑咬动作
  broadcast(room, { t: 'fx', k: 'pounce', i: attacker.id, ry: +ry.toFixed(2) });
  return true;
}

// 每 tick 推进正在扑咬的人
function stepPounces(room) {
  const dt = TICK / 1000;
  const now = Date.now();
  for (const p of room.players.values()) {
    if (!p.pouncing) continue;
    if (!p.alive || p.team !== 'hide') { p.pouncing = false; continue; }
    const step = POUNCE_DASH * dt;
    const nx = p.x + (p.pdx || 0) * step;
    const nz = p.z + (p.pdz || 0) * step;
    if (!blockedPoint(nx, nz, 0.45)) {
      p.x = Math.max(-ARENA + 0.6, Math.min(ARENA - 0.6, nx));
      p.z = Math.max(-ARENA + 0.6, Math.min(ARENA - 0.6, nz));
    }
    if (now >= p.pEndAt) {
      p.pouncing = false;
      const ate = resolvePounce(room, p);
      if (ate && !p.rage) {
        // 吃完人马上隐身：重新变成道具，不留破绽
        p.hiding = true;
        p.model = PROP_TYPES[Math.floor(Math.random() * PROP_TYPES.length)];
        p.hideGrace = now + 1200;
        if (!p.isBot) send(p.ws, { t: 'event', kind: 'good', text: '吃掉一个，立刻重新隐身！' });
      }
    }
  }
}

function resolvePounce(room, attacker) {
  // 一次扑咬最多吃掉一个人：先挑最近的调查员
  let target = null, best = Infinity;
  for (const q of room.players.values()) {
    if (q.team !== 'hunt' || !q.alive) continue;
    const d = Math.hypot(q.x - attacker.x, q.z - attacker.z);
    if (d <= POUNCE_RANGE && d < best) { best = d; target = q; }
  }
  if (!target) return false;
  if (target.hasShield) {
    target.hasShield = false;
    if (!target.isBot) send(target.ws, { t: 'event', kind: 'info', text: '护身符碎裂，挡住了这次扑咬！' });
    event(room, `${attacker.name} 扑到护身符，扑空了`, 'warn');
    return false;
  }
  target.alive = false;
  if (!target.isBot) send(target.ws, { t: 'dead', by: 'pounce' });
  event(room, `${attacker.name} 扑咬成功，一名调查员被淘汰`, 'danger');
  return true;
}

function doShoot(room, shooter, o, d) {
  if (shooter.team !== 'hunt' || !shooter.alive || shooter.bullets <= 0) return;
  // 狂暴阶段调查员不能开枪
  if (room.phase === 'rage') {
    if (!shooter.isBot) send(shooter.ws, { t: 'event', kind: 'warn', text: '狂暴阶段枪打不出去了！' });
    return;
  }
  if (!Array.isArray(o) || !Array.isArray(d)) return;
  shooter.bullets -= 1;

  let dx = d[0], dy = d[1], dz = d[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  dx /= len; dy /= len; dz /= len;

  const notify = (text, kind) => { if (!shooter.isBot) send(shooter.ws, { t: 'event', kind, text }); };

  const wallT = blocked(o[0], o[1], o[2], dx, dy, dz, SHOOT_RANGE);

  // 命中玩家（站在物品上开枪，高度上限跟着抬高）
  const shootCap = 1.6 + Math.max(0, shooter.y || 0);
  let best = null, bestT = SHOOT_RANGE;
  for (const q of room.players.values()) {
    if (q.team !== 'hide' || !q.alive || q === shooter) continue;
    if (room.phase === 'prepare') continue; // 准备阶段看不见，也打不到
    if (q.hideGrace && q.hideGrace > Date.now()) continue; // 刚吃完人隐身的那一下抓不到
    const radius = q.hiding ? 1.0 : 0.8;
    const t = rayPlayer(o[0], o[1], o[2], dx, dy, dz, q, radius, shootCap);
    if (t !== null && t < bestT) { best = q; bestT = t; }
  }
  // 命中诱饵
  let bestDecoy = null, bestDecoyT = SHOOT_RANGE;
  for (const dcy of room.decoys) {
    const t = rayPlayer(o[0], o[1], o[2], dx, dy, dz, { x: dcy.x, z: dcy.z }, 0.7, shootCap + 0.4);
    if (t !== null && t < bestDecoyT) { bestDecoy = dcy; bestDecoyT = t; }
  }

  if (wallT !== null && (bestT > wallT || bestDecoyT > wallT)) {
    notify('子弹打在墙上', 'info');
    return;
  }

  if (best && (!bestDecoy || bestT <= bestDecoyT)) {
    best.alive = false;
    if (!best.isBot) send(best.ws, { t: 'dead', by: 'shoot' });
    event(room, `${shooter.name} 找到并淘汰了 ${best.name}`, 'good');
  } else if (bestDecoy) {
    room.decoys = room.decoys.filter(x => x !== bestDecoy);
    notify('打到诱饵！子弹浪费了', 'warn');
  } else {
    notify('打空了', 'info');
  }
}

// ---------- 游戏流程 ----------
function startGame(room) {
  removeBots(room);
  const teamCap = Math.max(2, Math.min(MAX_PER_TEAM, Number(room.teamSize) || MAX_PER_TEAM));
  const fillTarget = Math.max(0, Math.min(teamCap, Number(room.botFill) || 0));
  const list = [...room.players.values()].filter(p => !p.isBot && p.ws && p.ws.readyState === 1);
  if (list.length === 0) return;
  if (list.length < 2 && fillTarget === 0) return event(room, '至少需要 2 名玩家才能开始（或开启人机补位）', 'warn');

  // 洗牌
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }

  // 尊重偏好，先按偏好排队
  const hideQueue = list.filter(p => p.pref === 'hide');
  const huntQueue = list.filter(p => p.pref === 'hunt');
  const rest = list.filter(p => p.pref !== 'hide' && p.pref !== 'hunt');

  const hide = hideQueue.slice(0, teamCap);
  const hunt = huntQueue.slice(0, teamCap);
  for (const p of rest) {
    if (hide.length < teamCap) hide.push(p);
    else if (hunt.length < teamCap) hunt.push(p);
  }
  // 仍不足则从另一队拿人 / 补到两边
  for (const p of hideQueue.slice(teamCap).concat(huntQueue.slice(teamCap))) {
    if (hide.length < teamCap) hide.push(p);
    else if (hunt.length < teamCap) hunt.push(p);
  }

  // 人机补位
  let hideFill = fillTarget, huntFill = fillTarget;
  if (room.asymFill) {
    // 1v4：有真人的那边不补人机，另一边补满
    const hd = hide.filter(p => !p.isBot).length;
    const hk = hunt.filter(p => !p.isBot).length;
    hideFill = hd > 0 ? hd : fillTarget;
    huntFill = hk > 0 ? hk : fillTarget;
  }
  let botSeq = 0;
  while (hide.length < hideFill) {
    hide.push(makeBot(room, 'hide', botSeq++, { x: -10, z: -10 }));
  }
  while (hunt.length < huntFill) {
    hunt.push(makeBot(room, 'hunt', botSeq++, { x: 10, z: 10 }));
  }

  room.players.forEach(p => { p.spectator = true; p.team = 'none'; });

  hide.forEach((p, idx) => {
    const s = MAP.hideSpawns[idx % MAP.hideSpawns.length];
    Object.assign(p, {
      team: 'hide', spectator: false, alive: true, hiding: true, pouncing: false, y: 0,
      model: PROP_TYPES[Math.floor(Math.random() * PROP_TYPES.length)],
      energy: 0, bullets: 0, hasShield: false, rage: false,
      x: s.x, z: s.z, ry: 0
    });
  });
  hunt.forEach((p, idx) => {
    const s = MAP.huntSpawns[idx % MAP.huntSpawns.length];
    Object.assign(p, {
      team: 'hunt', spectator: false, alive: true, hiding: false, model: null, pouncing: false, y: 0,
      energy: 0, bullets: MAX_BULLETS, hasShield: false, rage: false,
      x: s.x, z: s.z, ry: Math.PI
    });
  });

  room.phase = 'prepare';
  room.timer = PREPARE_TIME + PLAY_TIME;
  room.winner = null;
  room.endText = '';
  room.decoys = [];
  room.cabinets = rollCabinets();

  broadcast(room, { t: 'init', map: MAP, you: null, phase: room.phase });
  // 每个人单独知道自己是谁
  for (const p of room.players.values()) {
    send(p.ws, { t: 'you', id: p.id, team: p.team, spectator: p.spectator ? 1 : 0 });
  }
  event(room, '对局开始！躲藏者有 15 秒隐蔽时间', 'info');
  broadcastState(room);
}

function endGame(room, winner, text) {
  room.phase = 'end';
  room.winner = winner;
  room.endText = text;
  broadcast(room, { t: 'end', winner, text });
  broadcastState(room);
  // 5 秒后回到大厅
  setTimeout(() => {
    if (room.phase !== 'end') return;
    room.phase = 'lobby';
    removeBots(room);
    broadcastState(room);
    broadcastLobby(room);
  }, 5000);
}

function tick(room) {
  if (room.phase === 'prepare' || room.phase === 'playing' || room.phase === 'rage') {
    room.timer -= TICK / 1000;

    if (room.phase === 'prepare' && room.timer <= PLAY_TIME) {
      room.phase = 'playing';
      event(room, '调查员出动！开始搜索异常生物', 'warn');
      // 躲藏者人机已经就位，开局先安分蹲一段时间，别刚开局就到处跑暴露
      for (const p of room.players.values()) {
        if (p.isBot && p.team === 'hide' && p.alive) {
          p.bot.wp = null;
          p.bot.dwellUntil = Date.now() + 9000 + Math.random() * 5000;
          p.hiding = true;
        }
      }
    }

    if (room.timer <= 0 && room.phase !== 'rage') {
      const hideAlive = [...room.players.values()].filter(p => p.team === 'hide' && p.alive).length;
      if (hideAlive > 0) {
        room.phase = 'rage';
        room.timer = PLAY_TIME; // 给狂暴阶段一段时间
        for (const p of room.players.values()) {
          if (p.team === 'hide' && p.alive) {
            p.rage = true;
            p.hiding = false;
            p.energy = 100;
          }
        }
        event(room, '时间耗尽！异常生物进入狂暴模式', 'danger');
      } else {
        endGame(room, 'hunt', '所有异常生物都已被淘汰！');
      }
    }

    // 能量累积
    for (const p of room.players.values()) {
      if (p.team !== 'hide' || !p.alive || !p.hiding) continue;
      let near = false;
      for (const q of room.players.values()) {
        if (q.team === 'hunt' && q.alive && Math.hypot(q.x - p.x, q.z - p.z) < ENERGY_NEAR) { near = true; break; }
      }
      if (near) p.energy = Math.min(100, p.energy + ENERGY_RATE);
    }

    // 柜子里的东西 20 秒后重新刷出来（也可能一直是空的）
    const now = Date.now();
    for (const c of room.cabinets) {
      if (!c.item && c.respawnAt && now > c.respawnAt) {
        c.item = Math.random() < 0.6 ? (Math.random() < 0.55 ? 'detector' : 'shield') : null;
        c.respawnAt = c.item ? 0 : now + ITEM_RESPAWN;
      }
    }

    // 子弹：每 6 秒自动补 1 发，最多 3 发
    for (const p of room.players.values()) {
      if (p.team !== 'hunt' || !p.alive) continue;
      if (p.bullets >= MAX_BULLETS) { p.ammoAt = 0; continue; }
      if (!p.ammoAt) p.ammoAt = now + AMMO_REGEN;
      else if (now >= p.ammoAt) {
        p.bullets += 1;
        p.ammoAt = p.bullets < MAX_BULLETS ? now + AMMO_REGEN : 0;
      }
    }

    // 扑咬过程（冲刺 + 到点判定）
    stepPounces(room);

    // 诱饵不消失（只能被调查员打掉，或超过数量上限被挤掉）

    // 人机行动
    updateBots(room);

    // 胜负
    const hideAlive = [...room.players.values()].filter(p => p.team === 'hide' && p.alive).length;
    const huntAlive = [...room.players.values()].filter(p => p.team === 'hunt' && p.alive).length;
    if (hideAlive === 0 && room.phase !== 'end') endGame(room, 'hunt', '所有异常生物都已被淘汰！');
    else if (huntAlive === 0 && room.phase !== 'end') endGame(room, 'hide', '所有调查员都被击败，异常生物获胜！');
  }

  if (room.phase !== 'lobby' && room.phase !== 'end') {
    broadcastState(room);
  }
}

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.players.size === 0) { rooms.delete(room.code); continue; }
    try { tick(room); } catch (e) { console.error('[tick]', e); }
  }
}, TICK);

// ---------- WebSocket ----------
// ---------- 虚拟 WebSocket 服务端（在浏览器里跑） ----------
class FakeWSS {
  constructor() { this._conn = []; }
  on(ev, fn) { if (ev === "connection") this._conn.push(fn); }
  connect(ws) { for (const fn of this._conn) fn(ws); }
}
const wss = new FakeWSS();

wss.on('connection', (ws) => {
  let room = null;
  let me = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    // 房间列表查询（不需要先加入）
    if (msg.t === 'rooms') {
      send(ws, { t: 'rooms', list: roomList() });
      return;
    }

    // 加入
    if (msg.t === 'join') {
      if (me) return;
      const code = (typeof msg.room === 'string' && msg.room.trim() ? msg.room.trim() : 'default').slice(0, 12);
      const name = (typeof msg.name === 'string' && msg.name.trim() ? msg.name.trim() : '玩家').slice(0, 12);
      room = getRoom(code);
      // 空房间的第一位玩家决定对局规模（2v2 / 3v3 / 4v4）
      const humanCount = [...room.players.values()].filter(p => !p.isBot).length;
      if (humanCount === 0) {
        const sz = Math.max(2, Math.min(MAX_PER_TEAM, Number(msg.size) || 4));
        room.teamSize = sz;
        room.botFill = sz;
      }

      const taken = [...room.players.values()].map(p => p.name);
      let finalName = name;
      let n = 2;
      while (taken.includes(finalName)) finalName = name + n++;

      me = {
        ws, id: nextPid++, name: finalName,
        pref: ['hide', 'hunt', 'random'].includes(msg.pref) ? msg.pref : 'random',
        host: room.players.size === 0,
        x: 0, z: 0, ry: 0,
        team: 'none', alive: false, hiding: false, model: null,
        energy: 0, bullets: 0, hasShield: false, rage: false, spectator: false
      };
      room.players.set(me.id, me);
      room.touched = Date.now();

      send(ws, { t: 'joined', id: me.id, code, map: MAP });
      broadcastLobby(room);
      broadcastState(room);
      return;
    }

    if (!me || !room) return;

    switch (msg.t) {
      case 'pref': {
        if (['hide', 'hunt', 'random'].includes(msg.pref)) me.pref = msg.pref;
        broadcastLobby(room);
        break;
      }
      case 'fill': {
        if (!me.host) return;
        const n = Number(msg.n);
        room.asymFill = msg.mode === 'asym';
        room.botFill = Math.max(0, Math.min(room.teamSize, Number.isFinite(n) ? n : room.teamSize));
        broadcastLobby(room);
        break;
      }
      case 'size': {
        if (!me.host) return;
        const sz = Math.max(2, Math.min(MAX_PER_TEAM, Number(msg.n) || room.teamSize));
        if (room.phase !== 'lobby' && room.phase !== 'end') return;
        room.teamSize = sz;
        if (room.botFill > sz) room.botFill = sz;
        if (room.botFill === 0 && msg.autoFill) room.botFill = sz;
        broadcastLobby(room);
        break;
      }
      case 'start': {
        if (!me.host) return send(ws, { t: 'event', kind: 'warn', text: '只有房主可以开始游戏' });
        if (room.phase !== 'lobby' && room.phase !== 'end') return;
        startGame(room);
        break;
      }
      case 'move': {
        if (!Array.isArray(msg.p)) return;
        me.ry = Number(msg.ry) || 0;
        if (me.pouncing) break;   // 扑咬冲刺期间位置由服务端算
        me.x = Number(msg.p[0]) || 0;
        me.z = Number(msg.p[1]) || 0;
        const y = Number(msg.y);
        me.y = Number.isFinite(y) ? Math.max(0, Math.min(MAX_Y, y)) : 0;
        clampPos(me);
        break;
      }
      case 'hide': {
        if (me.team !== 'hide' || !me.alive || me.rage) return;
        me.hiding = !me.hiding;
        if (me.hiding) {
          if (typeof msg.m === 'number' && PROP_TYPES[msg.m]) me.model = PROP_TYPES[msg.m];
          else if (!me.model) me.model = PROP_TYPES[Math.floor(Math.random() * PROP_TYPES.length)];
        }
        break;
      }
      case 'model': {
        if (me.team !== 'hide' || !me.alive) return;
        if (typeof msg.m === 'number' && PROP_TYPES[msg.m]) me.model = PROP_TYPES[msg.m];
        break;
      }
      case 'taunt': {
        if (me.team !== 'hide' || !me.alive) return;
        const now = Date.now();
        const remain = TAUNT_CD - (now - (me.tauntAt || 0));
        if (remain > 0) {
          send(ws, { t: 'cd', taunt: remain });
          return;
        }
        // 必须附近有调查员才嘲讽得到（嘲讽会暴露自己 3.5 秒）
        let nearHunter = null, nd = Infinity;
        for (const q of room.players.values()) {
          if (q.team !== 'hunt' || !q.alive) continue;
          const dd = Math.hypot(q.x - me.x, q.z - me.z);
          if (dd <= TAUNT_NEAR && dd < nd) { nd = dd; nearHunter = q; }
        }
        if (!nearHunter) {
          send(ws, { t: 'event', kind: 'warn', text: '附近没有调查员，嘲讽不到' });
          return;
        }
        me.tauntAt = now;
        me.tauntUntil = now + TAUNT_TIME;
        me.energy = Math.min(100, me.energy + TAUNT_ENERGY);
        send(ws, { t: 'event', kind: 'info', text: '嘲讽中：暴露位置 3.5 秒！' });
        event(room, `${me.name} 在嘲讽（位置暴露 3.5 秒）`, 'warn');
        break;
      }
      case 'pounce': {
        doPounce(room, me);
        break;
      }
      case 'decoy': {
        if (me.team !== 'hide' || !me.alive) return;
        const now = Date.now();
        const remain = DECOY_CD - (now - (me.decoyAt || 0));
        if (remain > 0) {
          send(ws, { t: 'cd', decoy: remain });
          return;
        }
        me.decoyAt = now;
        room.decoys.push({ x: me.x, z: me.z, expire: now + 12000, owner: me.id });
        while (room.decoys.length > MAX_DECOYS) room.decoys.shift();
        break;
      }
      case 'searchDecoy': {
        // 调查员按 G 搜索：如果最近的是诱饵，识破后柜子消失
        if (me.team !== 'hunt' || !me.alive) return;
        let best = null, bd = OPEN_RANGE + 0.8;
        for (const dc of room.decoys) {
          const dd = Math.hypot(dc.x - me.x, dc.z - me.z);
          if (dd < bd) { bd = dd; best = dc; }
        }
        if (!best) return send(ws, { t: 'event', kind: 'info', text: '附近没有柜子' });
        room.decoys = room.decoys.filter(x => x !== best);
        send(ws, { t: 'event', kind: 'warn', text: '假柜子！是诱饵，砸开后柜子消失了' });
        event(room, `${me.name} 识破了一个诱饵`, 'info');
        break;
      }
      case 'shoot': {
        doShoot(room, me, msg.o, msg.d);
        break;
      }
      case 'openCab': {
        const got = openCabin(room, me, msg.id);
        if (got === null) return;
        if (got === 'empty') {
          send(ws, { t: 'event', kind: 'info', text: '柜子里是空的…' });
        } else if (got === 'detector') {
          send(ws, { t: 'detector', ms: 4000 });
        } else {
          send(ws, { t: 'event', kind: 'good', text: '柜子里翻到护身符：可抵挡一次扑咬' });
        }
        break;
      }
      case 'back': {
        if (room.phase === 'end' || room.phase === 'lobby') {
          me.alive = false; me.spectator = true; me.team = 'none';
          broadcastLobby(room);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!room || !me) return;
    room.players.delete(me.id);
    if (room.players.size === 0) { rooms.delete(room.code); return; }
    // 房主转移
    if (me.host) {
      const next = [...room.players.values()][0];
      if (next) next.host = true;
    }
    broadcastLobby(room);
    broadcastState(room);
  });
  ws.on('error', () => {});
});


// ---------- 导出 ----------
export { wss, rooms, roomList, MAP, PROP_TYPES, MAX_PER_TEAM };

// 给浏览器端用的封装：接管一个虚拟客户端
export function attachVirtualSocket(ws) { wss.connect(ws); }

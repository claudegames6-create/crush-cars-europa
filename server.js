'use strict';
/* =====================================================================
   CRUSH CARS · SERVIDOR MULTIJUGADOR (Node + Socket.io)
   - Carga el MISMO juego (index.html) y ejecuta su lógica real (física, IA de bots, recompensas).
   - Sirve el juego en "/" y una comprobación de estado en "/health".
   - Variables de entorno opcionales:
       PORT         (Render lo pone solo)
       GAME_FILE    ruta del HTML del juego (por defecto: index.html junto a este archivo)
       STRICT_HASH  =1 para EXIGIR que el juego del cliente sea idéntico al del servidor (por defecto solo avisa en el log)
   ===================================================================== */
const fs = require('fs'), path = require('path'), http = require('http'), vm = require('vm'), crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = +process.env.PORT || 3000;
const STRICT_HASH = process.env.STRICT_HASH === '1';

/* ---------------------------------------------------------------------
   1. CARGAR EL JUEGO
   --------------------------------------------------------------------- */
function findGameFile() {
  if (process.env.GAME_FILE) return path.resolve(process.env.GAME_FILE);
  const idx = path.join(__dirname, 'index.html');
  if (fs.existsSync(idx)) return idx;
  const f = fs.readdirSync(__dirname).find(n => /\.html?$/i.test(n));
  return f ? path.join(__dirname, f) : null;
}
const GAME_FILE = findGameFile();
if (!GAME_FILE || !fs.existsSync(GAME_FILE)) {
  console.error('✖ No encuentro el HTML del juego. Sube tu archivo al repositorio con el nombre index.html (junto a server.js).');
  process.exit(1);
}
const HTML = fs.readFileSync(GAME_FILE, 'utf8');

function mkStub() {   // objeto "comodín": cualquier propiedad o llamada devuelve otro comodín (simula el DOM que el servidor no necesita)
  const p = new Proxy(function () {}, {
    get(t, k) { if (k === Symbol.toPrimitive) return () => ''; if (typeof k === 'symbol' || k === 'then') return undefined; if (k === 'length') return 0; return p; },
    set() { return true }, apply() { return p }, construct() { return p }, has() { return false },
  });
  return p;
}
function loadCore(html) {
  const m = html.match(/<script>\s*('use strict';[\s\S]*?)<\/script>/);
  if (!m) throw new Error('No encuentro el <script> principal en ' + GAME_FILE);
  let code = m[1].replace("go(save.name ? 'menu' : 'welcome');", '');
  code += `
;globalThis.__G = { CARS, CAR_BY_ID, MAPS, SURV_MAPS, CROWNS, SKYCR: typeof SKYCR !== 'undefined' ? SKYCR : null, CROWN_MAPS, SURV_ROUNDS, SURV_NAMES, CC, CC_LIST, MPC, PFX_BY_ID,
  mpHash, mpCreateRace, mpCollide, mpEncode, mpDecode, mpApplyFlags, mpReward, mpCleanUpg,
  aiInput, stepCar, progress, collide, locate, pointAt, setEmitOff: v => { EMIT_OFF = v; } };`;
  const stub = mkStub();
  const sb = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams, performance,
    document: stub, navigator: stub, history: stub, matchMedia: () => stub,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { search: '', protocol: 'https:', origin: '', host: '', pathname: '/' },
    innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
    Path2D: class { moveTo() {} lineTo() {} closePath() {} }, KeyboardEvent: class {},
  };
  sb.window = sb; sb.self = sb;
  vm.createContext(sb);
  vm.runInContext(code, sb, { filename: 'crush-cars-game.js' });
  return sb.__G;
}
let G;
try { G = loadCore(HTML); } catch (e) { console.error('✖ Error cargando la lógica del juego:', e); process.exit(1); }
G.setEmitOff(true);   // el servidor no dibuja partículas
const HASH = G.mpHash();
console.log('✔ Juego cargado desde', path.basename(GAME_FILE), '· huella', HASH);

/* ---------------------------------------------------------------------
   2. UTILIDADES
   --------------------------------------------------------------------- */
const uid = n => crypto.randomBytes(n).toString('hex');
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const clampI = (v, a, b, d) => { v = Math.floor(Number(v)); return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
const cleanName = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 16);
const CODE_CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => { let c; do { c = 'CC-'; for (let i = 0; i < 5; i++) c += CODE_CH[Math.floor(Math.random() * CODE_CH.length)]; } while (rooms.has(c)); return c; };
const popcount = n => { let c = 0; while (n) { c += n & 1; n >>>= 1; } return c; };
const SKILL = [0.25, 0.55, 0.8, 1];
const SURV_TBL = [[120, 50], [200, 80], [320, 120], [900, 300]];

const rooms = new Map(), players = new Map();

/* ---------------------------------------------------------------------
   3. SALAS Y JUGADORES
   --------------------------------------------------------------------- */
function setProf(P, prof) {
  if (!prof || typeof prof !== 'object') return;
  P.name = cleanName(prof.name) || P.name || 'PILOTO';
  P.av = clampI(prof.av, 0, 7, P.av || 0);
  P.lvl = clampI(prof.lvl, 1, 60, P.lvl || 1);
  if (Array.isArray(prof.owned)) { const o = prof.owned.filter(id => G.CAR_BY_ID[id]); if (!o.includes('volt')) o.push('volt'); P.owned = o; }
  if (G.CAR_BY_ID[prof.carId]) P.carId = prof.carId;
  P.upg = G.mpCleanUpg(prof.upg);
  P.pfx = G.PFX_BY_ID[prof.pfx] ? prof.pfx : 'classic';
}
function blockOf(room, P) {
  const cfg = room.cfg; if (cfg.unlockAll) return '';
  if (!P.owned.includes(P.carId)) return 'coche';
  if (room.kind !== 'surv') { const m = G.MAPS.find(x => x.id === cfg.mapId); if (m && P.lvl < m.lvl) return 'nivel ' + m.lvl; }
  return '';
}
const maxHumans = r => (r.kind === 'surv' ? 8 : r.mode === 'duel' ? 2 : 8);
function fixBots(r) {
  const h = r.players.length;
  r.cfg.bots = r.kind === 'surv' ? Math.max(0, 12 - h) : clampI(r.cfg.bots, 0, 8 - h, 0);
}
function roomView(r) {
  return {
    code: r.code, phase: r.phase, kind: r.kind, mode: r.mode, host: r.host, maxHumans: maxHumans(r), state: r.state, cfg: r.cfg,
    players: r.players.map(p => ({ pid: p.pid, name: p.name, av: p.av, lvl: p.lvl, carId: p.carId, upg: p.upg, pfx: p.pfx, ready: p.pid === r.host ? true : p.ready, host: p.pid === r.host, connected: p.connected, block: blockOf(r, p) })),
  };
}
function broadcast(r) { const v = roomView(r); for (const p of r.players) if (p.connected && p.sock) p.sock.emit('room', v); }
function destroyRoom(r) { clearTimeout(r.timer); r.race = null; for (const p of r.players) { p.room = null; } rooms.delete(r.code); }
function leaveRoom(P) {
  const r = P.room; if (!r) return;
  P.room = null; P.ready = false; try { if (P.sock) P.sock.leave(r.code); } catch (e) { /* */ }
  r.players = r.players.filter(p => p !== P);
  if (r.race) { const c = r.race.byPid[P.pid]; if (c) { c.dnf = true; c.gone = true; } }
  if (!r.players.length) { destroyRoom(r); return; }
  if (r.host === P.pid) { const nh = r.players.find(p => p.connected) || r.players[0]; r.host = nh.pid; }
  fixBots(r); broadcast(r);
}
function pickMap(id) { return G.MAPS.some(m => m.id === id) ? id : G.MAPS[0].id; }

/* ---------------------------------------------------------------------
   4. PREPARAR Y LANZAR UNA CARRERA
   --------------------------------------------------------------------- */
const humanEntry = P => ({ pid: P.pid, human: true, name: P.name, av: P.av, carId: P.carId, upg: P.upg, pfx: P.pfx });
function lobbyBots(count, diff) {
  const names = shuffle(G.SURV_NAMES.slice()), out = [];
  for (let i = 0; i < count; i++) {
    const [name, col] = names[i % names.length];
    out.push({ pid: 'bot' + i + uid(2), human: false, name, col, av: 0, upg: {}, pfx: null, carId: G.CARS[Math.floor(Math.random() * G.CARS.length)].id,
      rr: G.MPC.DIFFS[diff].r + (Math.random() - 0.5) * 0.03, pace: 0.985 + Math.random() * 0.03, fixedSkill: SKILL[diff] });
  }
  return out;
}
/* pista de la ronda de supervivencia: las 4 pistas de la corona elegida (si no hay corona válida, las 4 clásicas) */
const CROWN_ALL = G.SKYCR ? G.CROWNS.concat([G.SKYCR]) : G.CROWNS;   // 8 coronas + la de los cielos (secreta: solo la ofrece el cliente del anfitrión si la tiene desbloqueada)
function survMap(cfg, round) {
  const cr = CROWN_ALL.find(c => c.id === cfg.crown);
  return cr ? cr.tracks[round] : G.SURV_MAPS[round];
}
function survBots(count) {
  const names = shuffle(G.SURV_NAMES.slice()), q = shuffle(names.map((_, i) => i / (names.length - 1))), out = [];
  for (let i = 0; i < count; i++) {
    const [name, col] = names[i % names.length];
    out.push({ pid: 'bot' + i + uid(2), human: false, name, col, av: 0, upg: {}, pfx: null, carId: G.CARS[i % G.CARS.length].id, q: q[i % q.length], nz: (Math.random() - 0.5) * 0.02, pace: 0.985 + Math.random() * 0.03 });
  }
  return out;
}
function startRoom(room) {
  const humans = room.players.map(humanEntry);
  if (room.kind === 'surv') {
    room.tour = { round: 0 };
    launch(room, humans.concat(survBots(Math.max(0, 12 - humans.length))), 0);
  } else {
    launch(room, humans.concat(lobbyBots(room.cfg.bots, room.cfg.diff)), 0);
  }
}
function launch(room, field, round) {
  const surv = room.kind === 'surv', cfg = room.cfg;
  const mapDef = surv ? survMap(cfg, round) : G.MAPS.find(m => m.id === cfg.mapId) || G.MAPS[0];
  const raceId = uid(6), seed = Math.floor(Math.random() * 0x7fffffff);
  const rcfg = { mapId: mapDef.id, rev: surv ? false : !!cfg.rev, cc: cfg.cc, laps: surv ? mapDef.laps : cfg.laps, seed, raceId, ev: cfg.ev || 'chaos' };
  const slots = shuffle(field.map((_, i) => i)), fieldBy = {};
  const grid = field.map((e, i) => {
    fieldBy[e.pid] = e;
    const g = { pid: e.pid, name: e.name, av: e.av, carId: e.carId, upg: e.upg, pfx: e.pfx || null, slot: slots[i], col: e.col };
    if (!e.human) {
      let rr, skill;
      if (surv) { const lo = mapDef.ai[0], hi = mapDef.ai[1]; rr = lo + (hi - lo) * e.q + e.nz; skill = Math.min(1, Math.max(0, (rr - 0.86) / 0.21)) * 0.7 + 0.3; }
      else { rr = e.rr; skill = e.fixedSkill; }
      g.bot = { r: rr, pace: e.pace, skill };
    }
    return g;
  });
  const R = G.mpCreateRace(rcfg, grid, null, 'server');
  const rc = { R, cfg: rcfg, grid, raceId, map: mapDef, round, fieldBy, byPid: {}, startAt: Date.now() + 5000, last: Date.now(), lastSnap: 0, q: 0, firstFin: 0, endAt: 0, startedAt: Date.now() };
  for (const c of R.cars) { rc.byPid[c.pid] = c; if (!c.bot) { c.cpSeen = 1 << (G.MPC.CP - 1); c.lastPkt = 0; c.live = false; c.strikes = 0; } else c.stuckT = 0; }
  rc.bots = R.cars.filter(c => c.bot); rc.humans = R.cars.filter(c => !c.bot);
  if (surv) rc.surv = { k: G.SURV_ROUNDS[round].k, n: field.length };
  room.race = rc; room.state = 'race';
  const msg = { raceId, startAt: rc.startAt, cfg: rcfg, grid, surv: surv ? { round, k: rc.surv.k, n: rc.surv.n } : undefined };
  for (const p of room.players) { p.ready = false; if (p.connected) p.sock.emit('start', msg); }
  broadcast(room);
}
function nextRound(room) {
  if (!rooms.has(room.code)) return;
  room.timer = null;
  const tour = room.tour; if (!tour) return;
  tour.round++;
  const field = tour.field.map(e => {   // un humano que ya no está conectado pasa a ser un bot (para no dejar un coche parado)
    if (!e.human) return e;
    const p = room.players.find(x => x.pid === e.pid);
    if (p && p.connected) return e;
    return { pid: 'bot-' + e.pid, human: false, name: e.name, col: '#9aa4c4', av: 0, upg: {}, pfx: null, carId: e.carId, q: 0.5, nz: 0, pace: 1 };
  });
  if (!field.some(e => e.human)) return endTournament(room);
  launch(room, field, tour.round);
}
function endTournament(room) {
  room.state = 'lobby'; room.tour = null; room.race = null; for (const p of room.players) p.ready = false; broadcast(room);
}

/* ---------------------------------------------------------------------
   5. SIMULACIÓN DE LA CARRERA EN EL SERVIDOR
   --------------------------------------------------------------------- */
const ranking = R => R.cars.slice().sort((a, b) => a.finished !== b.finished ? (a.finished ? -1 : 1) : a.finished ? a.finishT - b.finishT : ((a.dnf ? 1 : 0) - (b.dnf ? 1 : 0)) || (b.dist - a.dist));

function applyState(rc, P, s) {   // estado que envía un cliente (su propio coche)
  const c = rc.byPid[P.pid]; if (!c || c.dnf) return;
  const d = G.mpDecode(s); if (d.cid !== c.cid) return;
  for (const k of ['x', 'y', 'a', 'vx', 'vy', 'nitro', 'abT', 'abCd', 'spin', 'steer']) if (!Number.isFinite(d[k])) return;
  const now = performance.now(), dt = c.lastPkt ? Math.min((now - c.lastPkt) / 1000, 1) : 0.1;
  if (c.live) {   // anti-teletransporte
    const dist = Math.hypot(d.x - c.x, d.y - c.y), lim = c.maxV * Math.max(dt, 0.05) + 80;
    if (dist > lim && c.strikes < 12) { c.strikes++; c.lastPkt = now; return; }
  }
  c.strikes = 0;
  const sp = Math.hypot(d.vx, d.vy); if (sp > c.maxV) { const k = c.maxV / sp; d.vx *= k; d.vy *= k; }
  c.x = d.x; c.y = d.y; c.a = d.a; c.vx = d.vx; c.vy = d.vy;
  G.mpApplyFlags(c, d.fl & 63);
  c.nitro = d.nitro; c.abT = d.abT; c.abCd = d.abCd; c.spin = d.spin; c.steer = d.steer;
  c.live = true; c.lastPkt = now; c.gone = false;
}
function humanProgress(c, R) {   // vueltas de los humanos: las decide el servidor (con comprobación de checkpoints)
  const T = R.T, sPrev = c.s; G.locate(c, T);
  const d = c.s - sPrev, CP = G.MPC.CP;
  c.cpSeen |= 1 << Math.min(CP - 1, Math.floor(c.s / T.L * CP));
  if (d < -T.L / 2) {
    const nl = c.lap + 1;
    if (nl <= c.maxLap) c.lap = nl;
    else if (nl === 0 || popcount(c.cpSeen) >= CP - 1) {
      c.lap = nl; c.maxLap = nl; const tc = R.t;
      if (nl >= 1) { const lt = tc - c.lapStart; c.lapTimes.push(lt); if (c.bestLap == null || lt < c.bestLap) c.bestLap = lt; }
      c.lapStart = tc; c.cpSeen = 1 << Math.min(CP - 1, Math.floor(c.s / T.L * CP));
      if (c.lap >= R.map.laps && !c.finished) { c.finished = true; c.finishT = tc; c.finishPos = ++R.finishCount; }
    }
  } else if (d > T.L / 2) c.lap--;
  c.dist = c.lap * T.L + c.s;
}
function stepRace(room, rc) {
  const now = Date.now(), R = rc.R, dt = Math.min(0.05, (now - rc.last) / 1000); rc.last = now;
  R.t = (now - rc.startAt) / 1000;
  if (R.t >= 0 && !rc.ended) {
    R.state = 'racing';
    const n = Math.max(1, Math.ceil(dt / 0.011)), h = dt / n; R.t -= dt;
    for (let s = 0; s < n; s++) {
      for (const c of rc.bots) { G.aiInput(c, R, h); G.stepCar(c, c.inp, h, R); }
      for (const c of rc.bots) G.progress(c, R, h);
      for (let i = 0; i < rc.bots.length; i++) for (let j = i + 1; j < rc.bots.length; j++) G.collide(rc.bots[i], rc.bots[j], R);
      for (const b of rc.bots) for (const u of rc.humans) if (!u.dnf && u.live) G.mpCollide(b, u, R);
      R.t += h;
    }
    for (const c of rc.bots) {   // rescate de bots atascados
      if (c.finished) continue;
      if (Math.hypot(c.vx, c.vy) < 30 && R.t > 1) c.stuckT += dt; else c.stuckT = 0;
      if (c.stuckT > 2.2) { const p = G.pointAt(R.T, c.s, 0); c.x = p.x; c.y = p.y; c.a = p.a; c.vx = c.vy = 0; c.spin = 0; c.stuckT = 0; }
    }
    for (const c of rc.humans) {
      if (c.dnf) continue;
      humanProgress(c, R);
      const P = room.players.find(p => p.pid === c.pid);
      if (!P || !P.connected) { c.gone = true; if (!c.offAt) c.offAt = now; if (now - c.offAt > 15000) c.dnf = true; } else c.offAt = 0;
    }
  } else R.state = R.t < 0 ? 'count' : R.state;
  const ord = ranking(R); ord.forEach((c, i) => { c.pos = i + 1; });
  if (now >= (rc.nextSnap || 0)) {   // 25 Hz con reloj propio: un tick tardío ya no deja huecos de 75 ms entre snapshots
    rc.nextSnap = Math.max((rc.nextSnap || now) + 40, now - 40); rc.lastSnap = now;
    const msg = { q: ++rc.q, rt: R.t, c: R.cars.map(G.mpEncode) };
    for (const p of room.players) if (p.connected && rc.byPid[p.pid]) p.sock.volatile.emit('snap', msg);   // volátil: si el cliente va justo de red se salta el viejo en vez de encolarlo
  }
  if (rc.ended || R.t < 0) { if (rc.ended && now >= rc.endAt) finalize(room, rc); return; }
  const active = rc.humans.filter(c => !c.finished && !c.dnf);
  if (rc.humans.some(c => c.finished) && !rc.firstFin) rc.firstFin = now;
  let end = false;
  if (rc.surv) end = R.finishCount >= rc.surv.k;
  else end = !active.length || (rc.firstFin && now - rc.firstFin > 60000);
  if (R.t > 15 * 60) end = true;
  if (end) { rc.ended = true; rc.endAt = now + 1500; }
}
function finalize(room, rc) {
  if (room.race !== rc) return;
  const R = rc.R, ord = ranking(R), n = ord.length, surv = room.kind === 'surv', test = !!room.cfg.unlockAll;
  const si = surv ? G.SURV_ROUNDS[rc.round] : null, k = si ? si.k : 0;
  const order = ord.map((c, i) => ({ pid: c.pid, pos: i + 1, human: !c.bot, av: c.av, name: c.name, carId: c.carId, fin: !!c.finished, finT: c.finished ? c.finishT : 0, best: c.bestLap, dnf: !!c.dnf, q: surv ? i < k : false }));
  let next, over = false, last = false;
  if (surv) {
    last = rc.round === G.SURV_ROUNDS.length - 1;
    const q = ord.slice(0, k), humansLeft = q.some(c => !c.bot && room.players.some(p => p.pid === c.pid && p.connected));
    over = last || !humansLeft;
    if (!over) next = { mapId: survMap(room.cfg, rc.round + 1).id, n: k, k: G.SURV_ROUNDS[rc.round + 1].k, at: Date.now() + 12000 };
  }
  const base = { raceId: rc.raceId, order, cfg: { mapId: rc.cfg.mapId, rev: rc.cfg.rev, cc: rc.cfg.cc, laps: rc.cfg.laps }, n, test, surv: surv ? { round: rc.round, k, n: si.n, last, over, next } : undefined };
  for (const p of room.players) {
    const c = rc.byPid[p.pid]; let mine = null;
    if (!test && c && c.finished) {
      const pos = ord.indexOf(c) + 1;
      if (surv) { const ok = pos <= k, t = SURV_TBL[rc.round], f = G.CC[rc.cfg.cc].rw; mine = { raceId: rc.raceId, pos, coins: Math.round((ok ? t[0] : 30 * (rc.round + 1)) * f), xp: Math.round((ok ? t[1] : 12 * (rc.round + 1)) * f) }; }
      else mine = Object.assign({ raceId: rc.raceId }, G.mpReward(pos, n, rc.map, rc.cfg.cc, rc.cfg.rev));
    }
    if (p.connected) p.sock.emit('res', Object.assign({}, base, { mine }));
  }
  room.race = null;
  if (surv && next) {
    room.tour.field = ord.slice(0, k).map(c => rc.fieldBy[c.pid]).filter(Boolean);
    room.state = 'wait'; room.timer = setTimeout(() => nextRound(room), 12000);
  } else { room.state = 'lobby'; room.tour = null; for (const p of room.players) p.ready = false; setTimeout(() => rooms.has(room.code) && broadcast(room), 300); }
}
setInterval(() => {
  for (const room of rooms.values()) {
    const rc = room.race; if (!rc) continue;
    try { stepRace(room, rc); } catch (e) {
      console.error('Error en la carrera', room.code, e); room.race = null; room.state = 'lobby'; room.tour = null;
      for (const p of room.players) if (p.connected) p.sock.emit('err', { code: 'race', msg: 'La carrera se ha cancelado por un error del servidor.' });
      broadcast(room);
    }
  }
}, 20);

/* ---------------------------------------------------------------------
   6. HTTP + SOCKET.IO
   --------------------------------------------------------------------- */
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/health' || u === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: players.size, uptime: Math.round(process.uptime()), hash: HASH }));
  }
  if (u === '/' || u === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(HTML); }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404');
});
const io = new Server(server, { cors: { origin: '*' }, transports: ['websocket', 'polling'], pingInterval: 10000, pingTimeout: 25000, perMessageDeflate: false, httpCompression: false });

io.on('connection', sock => {
  let P = null;
  const on = (ev, fn) => sock.on(ev, m => { try { fn(m && typeof m === 'object' ? m : {}); } catch (e) { console.error('Error en', ev, e); } });
  const err = (msg, code) => sock.emit('err', { code: code || 'error', msg });

  sock.on('ping', m => sock.emit('pong', { c: m && m.c, s: Date.now() }));

  on('hello', m => {
    if (m.proto !== G.MPC.PROTO) { err('Versión de protocolo distinta. Actualiza la página del juego.', 'version'); return sock.disconnect(true); }
    if (m.hash !== HASH) {
      console.warn('⚠ La huella del cliente no coincide (¿juego distinto al del servidor?)', m.hash, '≠', HASH);
      if (STRICT_HASH) { err('Tu versión del juego no coincide con la del servidor. Recarga la página (Ctrl+F5).', 'version'); return sock.disconnect(true); }
    }
    let resumed = false;
    const old = m.resume && players.get(m.resume.pid);
    if (old && old.token === m.resume.token) { P = old; P.sock = sock; P.connected = true; clearTimeout(P.dropT); resumed = true; }
    else { P = { pid: uid(4), token: uid(12), sock, name: cleanName(m.name) || 'PILOTO', av: clampI(m.av, 0, 7, 0), lvl: 1, owned: ['volt'], carId: 'volt', upg: G.mpCleanUpg(), pfx: 'classic', ready: false, connected: true, room: null }; players.set(P.pid, P); }
    sock.emit('welcome', { pid: P.pid, token: P.token, resumed, hash: HASH });
    if (P.room) { sock.join(P.room.code); broadcast(P.room); }
  });

  const need = fn => m => { if (!P) return; fn(m); };
  on('create', need(m => {
    leaveRoom(P); setProf(P, m.prof);
    const kind = m.kind === 'surv' ? 'surv' : 'race', mode = m.mode === 'party' ? 'party' : 'duel', mapId = pickMap(m.cfg && m.cfg.mapId), map = G.MAPS.find(x => x.id === mapId);
    const code = newCode();
    const room = { code, kind, mode, phase: 'party', host: P.pid, state: 'lobby', players: [P], race: null, tour: null, timer: null,
      cfg: { mapId, rev: !!(m.cfg && m.cfg.rev), cc: m.cfg && G.CC_LIST.includes(+m.cfg.cc) ? +m.cfg.cc : 150, laps: map.laps, bots: mode === 'party' && kind === 'race' ? 3 : 0, diff: 1, unlockAll: false, ev: 'chaos', crown: G.CROWNS[0].id } };
    fixBots(room); rooms.set(code, room); P.room = room; P.ready = false; sock.join(code); broadcast(room);
  }));
  on('join', need(m => {
    let code = String(m.code || '').toUpperCase().replace(/\s+/g, '');
    if (/^[A-Z0-9]{5}$/.test(code)) code = 'CC-' + code;
    const room = rooms.get(code);
    if (!room) return err('No existe ninguna sala con ese código.', 'noroom');
    if (room.players.includes(P)) { broadcast(room); return; }
    if (room.state !== 'lobby') return err('La carrera ya ha empezado. Espera a que termine.', 'started');
    if (room.players.length >= maxHumans(room)) return err('La sala está llena.', 'full');
    leaveRoom(P); setProf(P, m.prof); P.ready = false; P.room = room; room.players.push(P); sock.join(code); fixBots(room); broadcast(room);
  }));
  /* fases de la sala: 'party' (elegir coche) → 'menu' (el anfitrión elige modo) → 'lobby' (configurar y correr) */
  on('phase', need(m => {
    const r = P.room; if (!r || r.host !== P.pid || r.state !== 'lobby') return;
    if (m.v === 'menu' && r.phase === 'party') {
      if (r.players.length < 2) return err('Necesitas al menos un amigo en la sala para continuar.');
      if (r.players.some(p => !p.connected)) return err('Hay jugadores desconectados.');
    }
    if (m.v === 'menu' || m.v === 'party') { r.phase = m.v; for (const p of r.players) p.ready = false; broadcast(r); }
  }));
  on('mode', need(m => {
    const r = P.room; if (!r || r.host !== P.pid || r.state !== 'lobby' || r.phase !== 'menu') return;
    const kind = m.kind === 'surv' ? 'surv' : 'race';
    r.kind = kind; r.mode = 'party'; r.phase = 'lobby';
    r.cfg.bots = kind === 'surv' ? 0 : (r.botsPref == null ? 3 : r.botsPref); r.cfg.unlockAll = false;
    if (kind === 'surv' && !CROWN_ALL.some(x => x.id === r.cfg.crown)) r.cfg.crown = G.CROWNS[0].id;
    for (const p of r.players) p.ready = false;
    fixBots(r); broadcast(r);
  }));
  on('leave', need(() => leaveRoom(P)));
  on('prof', need(m => { const r = P.room; if (!r || r.state !== 'lobby') return; setProf(P, m.prof); broadcast(r); }));
  on('ready', need(m => { const r = P.room; if (!r || r.state !== 'lobby') return; P.ready = !!m.v; broadcast(r); }));
  on('cfg', need(m => {
    const r = P.room; if (!r || r.host !== P.pid || r.state !== 'lobby' || !m.cfg) return;
    const c = r.cfg, k = m.cfg;
    if ('mapId' in k && G.MAPS.some(x => x.id === k.mapId)) c.mapId = k.mapId;
    if ('crown' in k && r.kind === 'surv' && CROWN_ALL.some(x => x.id === k.crown)) c.crown = k.crown;
    if ('mode' in k && r.kind === 'race' && (k.mode === 'duel' || k.mode === 'party') && !(k.mode === 'duel' && r.players.length > 2)) r.mode = k.mode;
    if ('laps' in k) c.laps = clampI(k.laps, 1, G.MPC.LAPS_MAX, c.laps);
    if ('rev' in k) c.rev = !!k.rev;
    if ('cc' in k && G.CC_LIST.includes(+k.cc)) c.cc = +k.cc;
    if ('ev' in k && ['off', 'one', 'chaos'].includes(k.ev)) c.ev = k.ev;
    if ('bots' in k) { c.bots = clampI(k.bots, 0, 8, c.bots); if (r.kind !== 'surv') r.botsPref = c.bots; }
    if ('diff' in k) c.diff = clampI(k.diff, 0, 3, c.diff);
    if ('unlockAll' in k) c.unlockAll = !!k.unlockAll;
    fixBots(r); broadcast(r);
  }));
  on('kick', need(m => {
    const r = P.room; if (!r || r.host !== P.pid || r.state !== 'lobby') return;
    const t = r.players.find(p => p.pid === m.pid); if (!t || t === P) return;
    if (t.sock) t.sock.emit('kick', { msg: 'El anfitrión te ha expulsado de la sala.' });
    leaveRoom(t);
  }));
  on('start', need(m => {
    const r = P.room; if (!r || r.host !== P.pid || r.state !== 'lobby') return;
    if (r.phase !== 'lobby') return err('Primero elige el modo de juego.');
    if (r.players.some(p => !p.connected)) return err('Hay jugadores desconectados.');
    if (r.players.some(p => blockOf(r, p))) return err('Algún jugador no cumple los requisitos (nivel o coche).');
    if (!m.go && r.players.some(p => p.pid !== r.host && !p.ready)) return err('Faltan jugadores por marcar "LISTO".');
    if (r.kind !== 'surv' && r.players.length + r.cfg.bots < 2) return err('Necesitas al menos 2 participantes (activa bots o espera a un amigo).');
    startRoom(r);
  }));

  on('st', need(m => { const r = P.room, rc = r && r.race; if (rc && Array.isArray(m.s)) applyState(rc, P, m.s); }));

  sock.on('disconnect', () => {
    if (!P || P.sock !== sock) return;
    P.connected = false;
    if (P.room) { const c = P.room.race && P.room.race.byPid[P.pid]; if (c) c.gone = true; broadcast(P.room); }
    P.dropT = setTimeout(() => { if (!P.connected) { leaveRoom(P); players.delete(P.pid); } }, 25000);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log('✔ Servidor CRUSH CARS escuchando en el puerto ' + PORT));
process.on('uncaughtException', e => console.error('uncaughtException', e));
process.on('unhandledRejection', e => console.error('unhandledRejection', e));

// 联机服务器：静态页面 + WebSocket 房间。服务器权威，客户端只收到自己视角的状态。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Game } from '../engine/game.js';
import { decide } from '../ai/ai.js';
import { CARDS } from '../engine/cards.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const PORT = Number(process.env.PORT || 3000);
const AI_DELAY = Number(process.env.AI_DELAY ?? 650);
const TURN_TIMEOUT = Number(process.env.TURN_TIMEOUT ?? 45000);
const OFFLINE_TIMEOUT = 1500;
const SIZES = [5, 8];
const AI_NAMES = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const rooms = new Map();   // code -> room
const tokenRoom = new Map(); // token -> code

const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

function roomInfo(room, token) {
  return {
    code: room.code, size: room.size, started: !!room.game, isHost: room.host === token,
    members: room.members.map((m) => ({ name: m.name, online: !!m.ws, host: m.token === room.host })),
  };
}
function pushRoom(room) {
  for (const m of room.members) send(m.ws, { t: 'room', room: roomInfo(room, m.token) });
}
function pushState(room) {
  room.dirty = false;
  const g = room.game;
  if (!g) return;
  for (const m of room.members) {
    if (!m.ws) continue;
    const pend = room.pending.get(m.token);
    send(m.ws, {
      t: 'state', view: g.view(m.token), log: g.logs.slice(-120),
      waiting: [...room.waiting],
      req: pend ? { ...pend.req, reqId: pend.reqId, deadline: pend.deadline } : null,
    });
  }
}
function schedule(room) {
  if (room.dirty) return;
  room.dirty = true;
  setTimeout(() => pushState(room), 30);
}

function startGame(room) {
  const players = room.members.map((m) => ({ id: m.token, name: m.name, ai: false }));
  for (let i = 0; players.length < room.size; i++) players.push({ id: `ai-${i}`, name: `电脑·${AI_NAMES[i]}`, ai: true });
  for (let i = players.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [players[i], players[j]] = [players[j], players[i]];
  }
  room.pending = new Map();
  room.waiting = new Set();
  room.seq = 0;
  const isAI = Object.fromEntries(players.map((p) => [p.id, p.ai]));
  let game;
  const io = {
    update: () => schedule(room),
    ask: (pid, req) => new Promise((resolve) => {
      if (room.game !== game) return; // 对局已被废弃
      const auto = () => { try { return decide(game.view(pid), req); } catch { return null; } };
      room.waiting.add(pid);
      const finish = (ans) => { room.waiting.delete(pid); schedule(room); resolve(ans); };
      if (isAI[pid]) { setTimeout(() => finish(auto()), AI_DELAY); schedule(room); return; }
      const m = room.members.find((x) => x.token === pid);
      const online = m && m.ws;
      const ms = online ? TURN_TIMEOUT : OFFLINE_TIMEOUT;
      const entry = {
        reqId: ++room.seq, req, deadline: Date.now() + ms,
        done: (ans) => { clearTimeout(entry.timer); room.pending.delete(pid); finish(ans); },
      };
      entry.timer = setTimeout(() => entry.done(auto()), ms);
      room.pending.set(pid, entry);
      schedule(room);
    }),
  };
  game = new Game({ players, io, seed: crypto.randomInt(2 ** 31) });
  room.game = game;
  pushRoom(room);
  game.run().catch((e) => {
    console.error('对局异常', e);
    game.over = true;
    game.result = { winner: 'draw', reason: '服务器错误' };
    game.logs.push('对局因服务器错误中止');
  }).finally(() => pushState(room));
}

function leaveRoom(token) {
  const room = rooms.get(tokenRoom.get(token));
  tokenRoom.delete(token);
  if (!room) return;
  if (room.game && !room.game.over) {
    // 对局中离开：保留座位，交给托管
    const m = room.members.find((x) => x.token === token);
    if (m) m.ws = null;
    room.pending.get(token)?.done(null);
  } else {
    room.members = room.members.filter((m) => m.token !== token);
  }
  if (!room.members.some((m) => m.ws)) { room.game = null; rooms.delete(room.code); return; }
  if (room.host === token) room.host = room.members.find((m) => m.ws).token;
  pushRoom(room);
}

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  let token = null, name = '玩家';
  const myRoom = () => rooms.get(tokenRoom.get(token));
  const err = (msg) => send(ws, { t: 'error', msg });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') {
      token = typeof m.token === 'string' && /^[\w-]{8,64}$/.test(m.token) ? m.token : crypto.randomUUID();
      name = String(m.name || '玩家').slice(0, 12).trim() || '玩家';
      send(ws, { t: 'hello', token, cards: CARDS });
      const room = myRoom();
      if (room) { // 断线重连
        const mem = room.members.find((x) => x.token === token);
        if (mem) {
          if (mem.ws && mem.ws !== ws) mem.ws.close();
          mem.ws = ws;
          pushRoom(room); pushState(room);
        }
      }
      return;
    }
    if (!token) return;
    const room = myRoom();
    switch (m.t) {
      case 'create': {
        if (room) leaveRoom(token);
        let code;
        do { code = String(crypto.randomInt(1000, 10000)); } while (rooms.has(code));
        const r = { code, size: SIZES.includes(m.size) ? m.size : 5, host: token, members: [{ token, name, ws }], game: null, pending: new Map(), waiting: new Set() };
        rooms.set(code, r); tokenRoom.set(token, code);
        pushRoom(r);
        break;
      }
      case 'join': {
        const r = rooms.get(String(m.code || '').trim());
        if (!r) return err('房间不存在');
        if (r.game && !r.game.over) return err('该房间对局进行中');
        if (r.members.length >= r.size) return err('房间已满');
        if (room) leaveRoom(token);
        r.members.push({ token, name, ws }); tokenRoom.set(token, r.code);
        pushRoom(r);
        break;
      }
      case 'size':
        if (room && room.host === token && !room.game && SIZES.includes(m.size) && room.members.length <= m.size) {
          room.size = m.size; pushRoom(room);
        }
        break;
      case 'start':
        if (room && room.host === token && !room.game) startGame(room);
        break;
      case 'again':
        if (room && room.host === token && room.game && room.game.over) {
          room.game = null;
          room.members = room.members.filter((x) => x.ws);
          pushRoom(room);
        }
        break;
      case 'answer': {
        const pend = room && room.pending.get(token);
        if (pend && pend.reqId === m.reqId) pend.done(m.ans && typeof m.ans === 'object' ? m.ans : null);
        break;
      }
      case 'leave':
        leaveRoom(token);
        send(ws, { t: 'room', room: null });
        break;
      default: break;
    }
  });

  ws.on('close', () => {
    const room = myRoom();
    if (!room) return;
    const mem = room.members.find((x) => x.token === token);
    if (!mem || mem.ws !== ws) return;
    if (room.game && !room.game.over) {
      mem.ws = null; // 保留座位，等待重连；期间由 AI 托管
      if (!room.members.some((x) => x.ws)) { room.game = null; for (const x of room.members) tokenRoom.delete(x.token); rooms.delete(room.code); return; }
      pushRoom(room);
    } else leaveRoom(token);
  });
});

server.listen(PORT, () => console.log(`烽烟 已启动： http://localhost:${PORT}`));

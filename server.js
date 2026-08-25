'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const {
  calculateRoundLimit,
  createPlayer,
  generateSecrets,
  playerRank,
  publicPlayer,
  submitGuess,
  validateConfig
} = require('./src/game');

const PORT = Number(process.env.PORT) || 6357;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const IDENTITIES_FILE = path.join(DATA_DIR, 'identities.json');
const rooms = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });

function readIdentities() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(IDENTITIES_FILE, 'utf8'))));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
}

const identities = readIdentities();

function persistIdentities() {
  const temporary = `${IDENTITIES_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(identities), null, 2));
  fs.renameSync(temporary, IDENTITIES_FILE);
}

function cleanName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 16) throw new Error('玩家 ID 需要为 1 到 16 个字符');
  return name;
}

function clientIp(socket) {
  return String(socket.handshake.address || '').replace(/^::ffff:/, '');
}

function fixedName(socket, requestedName) {
  const ip = clientIp(socket);
  const existing = identities.get(ip);
  if (existing) return existing;
  const name = cleanName(requestedName);
  identities.set(ip, name);
  persistIdentities();
  return name;
}

function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('hex');
}

function createRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = '';
    for (let index = 0; index < 6; index += 1) code += alphabet[crypto.randomInt(0, alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('暂时无法创建房间，请稍后再试');
}

function serializeRoom(room, viewerId) {
  const reveal = room.status === 'finished';
  const viewer = room.players.get(viewerId);
  return {
    code: room.code,
    mode: room.mode,
    status: room.status,
    hostId: room.hostId,
    targetCount: room.targetCount,
    length: room.length,
    roundLimit: room.roundLimit,
    createdAt: room.createdAt,
    finishedAt: room.finishedAt,
    viewerId,
    viewer: viewer ? { ...publicPlayer(viewer, true), token: viewer.token } : null,
    players: playerRank(room.players.values()).map((player) =>
      publicPlayer(player, reveal || player.id === viewerId)
    ),
    secrets: reveal ? room.secrets : undefined
  };
}

function emitRoom(room) {
  for (const player of room.players.values()) {
    if (player.socketId) io.to(player.socketId).emit('room:update', serializeRoom(room, player.id));
  }
}

function finishRoom(room) {
  if (room.status === 'finished') return;
  room.status = 'finished';
  room.finishedAt = Date.now();
}

function maybeFinishRoom(room) {
  const players = [...room.players.values()];
  if (room.status === 'playing' && players.length && players.every((player) => player.finishedAt)) {
    finishRoom(room);
  }
}

function findPlayer(room, token) {
  return [...room.players.values()].find((player) => player.token === token);
}

function addPlayer(room, name, socket) {
  if (room.status !== 'lobby') throw new Error('游戏已经开始，无法加入');
  if (room.players.size >= 30) throw new Error('房间人数已满');

  const player = createPlayer(randomId(8), name, room.targetCount);
  player.token = randomId();
  player.socketId = socket.id;
  room.players.set(player.id, player);
  socket.join(room.code);
  return player;
}

function leaveRoom(room, player) {
  player.connected = false;
  player.socketId = null;
  if (room.status === 'lobby') {
    room.players.delete(player.id);
    if (room.hostId === player.id) room.hostId = room.players.keys().next().value || null;
    if (!room.players.size) rooms.delete(room.code);
  } else if (room.status === 'playing' && !player.finishedAt) {
    player.failed = true;
    player.finishedAt = Date.now();
    maybeFinishRoom(room);
  }
}

function newRoom({ code, mode, targetCount, length, status }) {
  return {
    code,
    mode,
    status,
    hostId: null,
    targetCount,
    length,
    roundLimit: calculateRoundLimit(targetCount, length),
    secrets: generateSecrets(targetCount, length),
    players: new Map(),
    createdAt: Date.now(),
    finishedAt: null
  };
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, rooms: rooms.size, uptime: Math.floor(process.uptime()) });
});

io.on('connection', (socket) => {
  const handle = (callback, action) => {
    try {
      action();
    } catch (error) {
      callback({ ok: false, error: error.message || '操作失败' });
    }
  };

  socket.on('identity:get', (_payload, callback) => {
    callback({ ok: true, name: identities.get(clientIp(socket)) || null });
  });

  socket.on('game:solo', (payload, callback) => handle(callback, () => {
    const targetCount = Number(payload.targetCount);
    const length = Number(payload.length);
    validateConfig(targetCount, length);
    const room = newRoom({
      code: `SOLO-${randomId(4).toUpperCase()}`,
      mode: 'solo',
      targetCount,
      length,
      status: 'lobby'
    });
    const player = addPlayer(room, fixedName(socket, payload.name || '独行玩家'), socket);
    room.hostId = player.id;
    room.status = 'playing';
    rooms.set(room.code, room);
    callback({ ok: true, room: serializeRoom(room, player.id) });
  }));

  socket.on('room:create', (payload, callback) => handle(callback, () => {
    const targetCount = Number(payload.targetCount);
    const length = Number(payload.length);
    validateConfig(targetCount, length);
    const room = newRoom({
      code: createRoomCode(),
      mode: 'multi',
      targetCount,
      length,
      status: 'lobby'
    });
    const player = addPlayer(room, fixedName(socket, payload.name), socket);
    room.hostId = player.id;
    rooms.set(room.code, room);
    callback({ ok: true, room: serializeRoom(room, player.id) });
    emitRoom(room);
  }));

  socket.on('room:join', (payload, callback) => handle(callback, () => {
    const room = rooms.get(String(payload.code || '').trim().toUpperCase());
    if (!room || room.mode !== 'multi') throw new Error('房间不存在或已失效');
    const player = addPlayer(room, fixedName(socket, payload.name), socket);
    callback({ ok: true, room: serializeRoom(room, player.id) });
    emitRoom(room);
  }));

  socket.on('room:start', (payload, callback) => handle(callback, () => {
    const room = rooms.get(String(payload.code || '').toUpperCase());
    const player = room && findPlayer(room, String(payload.token || ''));
    if (!room || !player) throw new Error('房间验证失败');
    if (player.id !== room.hostId) throw new Error('只有房主可以开始');
    if (room.status !== 'lobby') throw new Error('游戏已经开始');
    room.status = 'playing';
    callback({ ok: true });
    emitRoom(room);
  }));

  socket.on('game:guess', (payload, callback) => handle(callback, () => {
    const room = rooms.get(String(payload.code || '').toUpperCase());
    const player = room && findPlayer(room, String(payload.token || ''));
    if (!room || !player) throw new Error('游戏验证失败，请重新进入');
    const result = submitGuess(room, player, String(payload.guess || ''));
    maybeFinishRoom(room);
    callback({ ok: true, result });
    emitRoom(room);
  }));

  socket.on('room:leave', (payload, callback) => handle(callback, () => {
    const room = rooms.get(String(payload.code || '').toUpperCase());
    const player = room && findPlayer(room, String(payload.token || ''));
    if (!room || !player) throw new Error('房间验证失败');
    leaveRoom(room, player);
    callback({ ok: true });
    if (rooms.has(room.code)) emitRoom(room);
  }));

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const player = [...room.players.values()].find((item) => item.socketId === socket.id);
      if (!player) continue;
      leaveRoom(room, player);
      if (rooms.has(room.code)) emitRoom(room);
      break;
    }
  });
});

setInterval(() => {
  const expiry = Date.now() - 12 * 60 * 60 * 1000;
  for (const [code, room] of rooms.entries()) {
    if ((room.finishedAt || room.createdAt) < expiry) rooms.delete(code);
  }
}, 60 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`数迹已启动：http://${HOST}:${PORT}`);
});

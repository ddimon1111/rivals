#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const HTTP_PORT = 8000;
const WS_PORT = 8080;
const MAX_HP = 100;
const RESPAWN_MS = 1800;

const indexPath = path.join(__dirname, 'index.html');

const httpServer = http.createServer((req, res) => {
  const reqPath = req.url === '/' ? '/index.html' : req.url;
  if (reqPath !== '/index.html') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  fs.readFile(indexPath, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Failed to read index.html');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`HTTP: http://localhost:${HTTP_PORT}`);
});

const wss = new WebSocketServer({ port: WS_PORT });
console.log(`WS: ws://localhost:${WS_PORT}`);

const clients = new Map();
const waitingQueue = [];
const rooms = new Map();

const mapObstacles = [
  { x: -8, y: 1.5, z: -6, half: 1.5 }, { x: 8, y: 1.5, z: -6, half: 1.5 },
  { x: -8, y: 1.5, z: 6, half: 1.5 }, { x: 8, y: 1.5, z: 6, half: 1.5 },
  { x: 0, y: 1.5, z: 0, half: 1.5 }, { x: 0, y: 1.5, z: 10, half: 1.5 },
  { x: 0, y: 1.5, z: -10, half: 1.5 }, { x: 12, y: 1.5, z: 0, half: 1.5 },
  { x: -12, y: 1.5, z: 0, half: 1.5 },
];

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastRoom(room, msg) {
  for (const id of room.players) {
    const c = clients.get(id);
    if (c) send(c.ws, msg);
  }
}

function removeFromQueue(id) {
  const idx = waitingQueue.indexOf(id);
  if (idx >= 0) waitingQueue.splice(idx, 1);
}

function buildLobbyState() {
  const players = waitingQueue.map((id) => ({ id, ready: true }));
  return { type: 'lobbyState', waiting: waitingQueue.length < 2, players };
}

function broadcastLobbyState() {
  const state = buildLobbyState();
  for (const c of clients.values()) {
    if (!c.roomId) send(c.ws, state);
  }
}

function makeSpawn(index) {
  return index === 0 ? { x: -14, y: 1, z: 0 } : { x: 14, y: 1, z: 0 };
}

function createRoom(aId, bId) {
  const roomId = uid();
  const room = {
    id: roomId,
    players: [aId, bId],
    state: new Map(),
    startedAt: Date.now(),
  };

  room.state.set(aId, { x: -14, y: 1, z: 0, yaw: 0, hp: MAX_HP, alive: true });
  room.state.set(bId, { x: 14, y: 1, z: 0, yaw: Math.PI, hp: MAX_HP, alive: true });

  rooms.set(roomId, room);
  clients.get(aId).roomId = roomId;
  clients.get(bId).roomId = roomId;

  send(clients.get(aId).ws, { type: 'matchStart', roomId, spawn: makeSpawn(0) });
  send(clients.get(bId).ws, { type: 'matchStart', roomId, spawn: makeSpawn(1) });

  const tick = setInterval(() => {
    const activeRoom = rooms.get(roomId);
    if (!activeRoom) {
      clearInterval(tick);
      return;
    }

    const players = [];
    for (const [id, st] of activeRoom.state.entries()) {
      players.push({ id, x: st.x, y: st.y, z: st.z, yaw: st.yaw, hp: st.hp });
    }
    broadcastRoom(activeRoom, { type: 'snapshot', roomId, players });
  }, 50);

  room.tick = tick;
}

function intersectsObstacle(point) {
  for (const o of mapObstacles) {
    if (
      Math.abs(point.x - o.x) <= o.half + 0.1 &&
      Math.abs(point.y - o.y) <= o.half + 0.1 &&
      Math.abs(point.z - o.z) <= o.half + 0.1
    ) return true;
  }
  return false;
}

function rayHitsTarget(origin, dir, target) {
  const center = { x: target.x, y: target.y + 0.4, z: target.z };
  const to = {
    x: center.x - origin.x,
    y: center.y - origin.y,
    z: center.z - origin.z,
  };
  const t = to.x * dir.x + to.y * dir.y + to.z * dir.z;
  if (t < 0 || t > 40) return null;

  const closest = {
    x: origin.x + dir.x * t,
    y: origin.y + dir.y * t,
    z: origin.z + dir.z * t,
  };

  const distSq =
    (closest.x - center.x) ** 2 +
    (closest.y - center.y) ** 2 +
    (closest.z - center.z) ** 2;

  return distSq <= 0.95 ** 2 ? closest : null;
}

function handleShoot(shooterId, origin, dir) {
  const shooter = clients.get(shooterId);
  if (!shooter || !shooter.roomId) return;
  const room = rooms.get(shooter.roomId);
  if (!room) return;

  broadcastRoom(room, { type: 'shot', ownerId: shooterId, origin, dir });

  if (intersectsObstacle(origin)) return;

  for (const victimId of room.players) {
    if (victimId === shooterId) continue;

    const victim = room.state.get(victimId);
    if (!victim || !victim.alive) continue;

    const hit = rayHitsTarget(origin, dir, victim);
    if (!hit) continue;
    if (intersectsObstacle(hit)) continue;

    victim.hp = Math.max(0, victim.hp - 20);
    broadcastRoom(room, {
      type: 'damage',
      targetId: victimId,
      hp: victim.hp,
      at: hit,
    });

    if (victim.hp === 0 && victim.alive) {
      victim.alive = false;
      broadcastRoom(room, { type: 'killed', killerId: shooterId, victimId });

      setTimeout(() => {
        const currentRoom = rooms.get(room.id);
        if (!currentRoom) return;
        const st = currentRoom.state.get(victimId);
        if (!st) return;
        const idx = currentRoom.players.indexOf(victimId);
        const spawn = makeSpawn(idx === 0 ? 0 : 1);
        st.x = spawn.x;
        st.y = spawn.y;
        st.z = spawn.z;
        st.yaw = idx === 0 ? 0 : Math.PI;
        st.hp = MAX_HP;
        st.alive = true;
        broadcastRoom(currentRoom, { type: 'respawn', id: victimId, spawn });
      }, RESPAWN_MS);
    }

    break;
  }
}

function leaveRoom(clientId) {
  const c = clients.get(clientId);
  if (!c || !c.roomId) return;

  const room = rooms.get(c.roomId);
  c.roomId = null;
  if (!room) return;

  clearInterval(room.tick);
  rooms.delete(room.id);

  for (const id of room.players) {
    if (id === clientId) continue;
    const other = clients.get(id);
    if (!other) continue;
    other.roomId = null;
    send(other.ws, { type: 'playerLeft', id: clientId });
    waitingQueue.push(id);
  }

  broadcastLobbyState();
}

wss.on('connection', (ws) => {
  const id = uid();
  clients.set(id, { id, ws, roomId: null });
  send(ws, { type: 'welcome', id });
  broadcastLobbyState();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }

    const client = clients.get(id);
    if (!client) return;

    if (msg.type === 'createMatch') {
      if (client.roomId) return;
      if (!waitingQueue.includes(id)) waitingQueue.push(id);
      broadcastLobbyState();

      if (waitingQueue.length >= 2) {
        const a = waitingQueue.shift();
        const b = waitingQueue.shift();
        if (a && b && clients.has(a) && clients.has(b)) createRoom(a, b);
        broadcastLobbyState();
      }
      return;
    }

    if (msg.type === 'joinMatch') {
      if (client.roomId) return;
      if (!waitingQueue.includes(id)) waitingQueue.push(id);
      broadcastLobbyState();

      if (waitingQueue.length >= 2) {
        const a = waitingQueue.shift();
        const b = waitingQueue.shift();
        if (a && b && clients.has(a) && clients.has(b)) createRoom(a, b);
        broadcastLobbyState();
      }
      return;
    }

    if (msg.type === 'inputState') {
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room) return;
      const st = room.state.get(id);
      if (!st || !st.alive) return;
      st.x = Number(msg.x) || st.x;
      st.y = Number(msg.y) || st.y;
      st.z = Number(msg.z) || st.z;
      st.yaw = Number(msg.yaw) || st.yaw;
      st.hp = Math.max(0, Math.min(MAX_HP, Number(msg.hp) || st.hp));
      return;
    }

    if (msg.type === 'shoot') {
      if (!client.roomId) return;
      const dir = msg.dir || {};
      const origin = msg.origin || {};
      const dv = Math.sqrt((dir.x || 0) ** 2 + (dir.y || 0) ** 2 + (dir.z || 0) ** 2);
      if (dv < 0.5 || dv > 1.5) return;

      const normDir = { x: dir.x / dv, y: dir.y / dv, z: dir.z / dv };
      const normOrigin = { x: Number(origin.x) || 0, y: Number(origin.y) || 0, z: Number(origin.z) || 0 };
      handleShoot(id, normOrigin, normDir);
    }
  });

  ws.on('close', () => {
    leaveRoom(id);
    removeFromQueue(id);
    clients.delete(id);
    broadcastLobbyState();
  });
});

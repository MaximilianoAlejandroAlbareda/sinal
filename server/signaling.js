'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { WebSocketServer } = require('ws')

const DIST = path.join(__dirname, '..', 'dist')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/** @type {Map<string, {code: string, hostId: string | null, live: boolean, peers: Map<string, {id: string, name: string, role: string, ws: any}>}>} */
const rooms = new Map()
let counter = 0

const nextId = () => `p${++counter}${Math.random().toString(36).slice(2, 7)}`
const clean = (value, max) => String(value ?? '').trim().slice(0, max)

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload))
}

function broadcast(room, payload, exceptWs) {
  for (const peer of room.peers.values()) {
    if (peer.ws !== exceptWs) send(peer.ws, payload)
  }
}

function hostOf(room) {
  if (!room.hostId) return null
  return room.peers.get(room.hostId) || null
}

function leave(ws) {
  const room = ws.room ? rooms.get(ws.room) : null
  if (!room) return
  ws.room = null

  room.peers.delete(ws.id)

  if (room.hostId === ws.id) {
    broadcast(room, { type: 'room-closed' }, ws)
    rooms.delete(room.code)
    return
  }

  broadcast(room, { type: 'peer-left', id: ws.id }, ws)
  if (room.peers.size === 0) rooms.delete(room.code)
}

function handle(ws, msg) {
  if (!msg || typeof msg.type !== 'string') return

  switch (msg.type) {
    case 'join': {
      if (ws.room) leave(ws)

      const code = clean(msg.room, 12).toUpperCase()
      const name = clean(msg.name, 24) || 'Convidado'
      const role = msg.role === 'host' ? 'host' : 'viewer'
      if (!/^[A-Z0-9]{4,8}$/.test(code)) {
        send(ws, { type: 'error', message: 'Código de sala inválido.' })
        return
      }

      let room = rooms.get(code)

      if (!room) {
        if (role !== 'host') {
          send(ws, { type: 'error', message: 'Sala não encontrada. Confira o link.' })
          return
        }
        room = { code, hostId: null, live: false, peers: new Map() }
        rooms.set(code, room)
      } else if (role === 'host' && hostOf(room)) {
        send(ws, { type: 'error', message: 'Já existe alguém transmitindo nesta sala.' })
        return
      }

      const peer = { id: ws.id, name, role, ws }
      room.peers.set(ws.id, peer)
      if (role === 'host') room.hostId = ws.id
      ws.room = code

      send(ws, {
        type: 'joined',
        self: { id: peer.id, name: peer.name, role: peer.role },
        room: { code, hostId: room.hostId, live: room.live },
        peers: [...room.peers.values()]
          .filter((p) => p.id !== peer.id)
          .map((p) => ({ id: p.id, name: p.name, role: p.role })),
      })

      broadcast(room, { type: 'peer-joined', peer: { id: peer.id, name: peer.name, role: peer.role } }, ws)
      return
    }

    case 'signal': {
      const room = ws.room ? rooms.get(ws.room) : null
      if (!room) return
      const target = room.peers.get(String(msg.to))
      if (!target) return
      send(target.ws, { type: 'signal', from: ws.id, data: msg.data })
      return
    }

    case 'chat': {
      const room = ws.room ? rooms.get(ws.room) : null
      const me = room ? room.peers.get(ws.id) : null
      if (!room || !me) return
      const text = clean(msg.text, 800)
      if (!text) return
      broadcast(room, { type: 'chat', from: ws.id, name: me.name, text, ts: Date.now() })
      return
    }

    case 'live': {
      const room = ws.room ? rooms.get(ws.room) : null
      if (!room || room.hostId !== ws.id) return
      room.live = Boolean(msg.live)
      broadcast(room, { type: 'live', live: room.live, from: ws.id })
      return
    }

    case 'leave': {
      leave(ws)
      return
    }
  }
}

function serveStatic(req, res) {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
  } catch {
    pathname = '/'
  }
  if (pathname === '/') pathname = '/index.html'

  const filePath = path.join(DIST, pathname)
  if (!filePath.startsWith(DIST + path.sep)) {
    res.writeHead(403).end('forbidden')
    return
  }

  fs.readFile(filePath, (err, data) => {
    if (!err) {
      res.writeHead(200, {
        'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-cache',
      })
      res.end(data)
      return
    }
    fs.readFile(path.join(DIST, 'index.html'), (err2, html) => {
      if (err2) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Interface não compilada. Rode "bun run build" antes de abrir o app.')
        return
      }
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' })
      res.end(html)
    })
  })
}

/**
 * Start the HTTP + signaling server.
 * @param {{port?: number, host?: string}} [options]
 * @returns {Promise<{port: number, host: string, close: () => Promise<void>}>}
 */
function startServer(options = {}) {
  const requested = Number(options.port ?? process.env.PORT)
  const port = Number.isInteger(requested) && requested > 0 && requested < 65536 ? requested : 8787
  const host = options.host || process.env.HOST || '127.0.0.1'

  const server = http.createServer(serveStatic)
  const wss = new WebSocketServer({ server })

  wss.on('connection', (ws) => {
    ws.id = nextId()
    ws.isAlive = true
    ws.room = null
    ws.on('pong', () => {
      ws.isAlive = true
    })
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      handle(ws, msg)
    })
    ws.on('close', () => leave(ws))
    ws.on('error', () => leave(ws))
  })

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate()
        continue
      }
      ws.isAlive = false
      ws.ping()
    }
  }, 30000)

  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve({
        port,
        host,
        close: () =>
          new Promise((done) => {
            clearInterval(heartbeat)
            for (const ws of wss.clients) ws.terminate()
            wss.close(() => server.close(() => done()))
          }),
      })
    })
  })
}

module.exports = { startServer, rooms }

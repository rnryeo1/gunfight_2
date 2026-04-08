/**
 * 멀티플레이 릴레이 서버
 *
 * 실행(권장): 프로젝트 루트에서 `npm run mp-server`
 * 또는: `cd server` 후 `npm install` · `npm start`
 *
 * 환경변수:
 *   PORT — Fly.io·Railway·Render 등이 부여 (없으면 MP_PORT·8787)
 *   MP_PORT — 로컬에서 포트 고정할 때
 *   MP_MAX_PLAYERS — 기본 64, 상한 96
 *
 * GET / 또는 /health → 200 (Render·Fly 등 헬스체크용)
 */
import http from 'http'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT || process.env.MP_PORT) || 8787
const MAX_PLAYERS = Math.min(96, Math.max(2, Number(process.env.MP_MAX_PLAYERS) || 64))

const server = http.createServer((req, res) => {
  if (req.headers.upgrade && String(req.headers.upgrade).toLowerCase() === 'websocket') {
    return
  }
  const path = req.url?.split('?')[0] || '/'
  if (path === '/' || path === '/health' || path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('gun-fight-mp ok')
    return
  }
  res.writeHead(404).end()
})

/** perMessageDeflate 기본값은 짧은 JSON을 자주 보낼 때 CPU·지연을 키우는 경우가 많음 */
const wss = new WebSocketServer({ server, perMessageDeflate: false })
/** roomId -> WebSocket[] */
const rooms = new Map()
/** roomId -> Map(slot -> last pose payload) — MMO 등 실시간 입장 시 기존 유저 위치 즉시 동기화 */
const roomLastPose = new Map()

function getLastPoseMap(roomId) {
  if (!roomLastPose.has(roomId)) roomLastPose.set(roomId, new Map())
  return roomLastPose.get(roomId)
}

function broadcast(roomId, payload, except) {
  const arr = rooms.get(roomId)
  if (!arr?.length) return
  let n = 0
  for (const c of arr) {
    if (c !== except && c.readyState === 1) n++
  }
  if (n === 0) return
  const s = JSON.stringify(payload)
  for (const c of arr) {
    if (c !== except && c.readyState === 1) c.send(s)
  }
}

wss.on('connection', (ws) => {
  ws._room = null
  ws._slot = null

  ws.on('message', (raw) => {
    let m
    try {
      m = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (m.type === 'join' && typeof m.room === 'string') {
      const rid = m.room.slice(0, 48).trim() || 'public'
      if (!rooms.has(rid)) rooms.set(rid, [])
      const arr = rooms.get(rid)
      if (arr.length >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ type: 'room_full' }))
        return
      }
      arr.push(ws)
      ws._room = rid
      ws._slot = arr.length - 1
      ws.send(JSON.stringify({ type: 'welcome', slot: ws._slot, room: rid }))
      const lasts = roomLastPose.get(rid)
      if (lasts) {
        for (const [slot, payload] of lasts) {
          if (slot === ws._slot) continue
          ws.send(JSON.stringify({ type: 'peer', from: slot, payload }))
        }
      }
      broadcast(rid, { type: 'peer_joined', slot: ws._slot }, ws)
      return
    }

    if (m.type === 'relay' && ws._room && m.payload !== undefined) {
      const p = m.payload
      if (
        p &&
        typeof p === 'object' &&
        p.kind === 'pose' &&
        typeof p.x === 'number' &&
        typeof p.z === 'number' &&
        ws._slot != null
      ) {
        getLastPoseMap(ws._room).set(ws._slot, p)
      }
      broadcast(ws._room, { type: 'peer', from: ws._slot, payload: m.payload }, ws)
    }
  })

  ws.on('close', () => {
    const rid = ws._room
    const leftSlot = ws._slot
    if (!rid) return
    const arr = rooms.get(rid)
    if (!arr) return
    const i = arr.indexOf(ws)
    if (i >= 0) arr.splice(i, 1)
    if (arr.length === 0) {
      rooms.delete(rid)
      roomLastPose.delete(rid)
    } else if (leftSlot != null) {
      getLastPoseMap(rid).delete(leftSlot)
      broadcast(rid, { type: 'peer_left', slot: leftSlot }, null)
    }
  })
})

server.listen(PORT, () => {
  console.log(
    `[mp-server] HTTP+WebSocket :${PORT} · GET /health · room당 최대 ${MAX_PLAYERS}인 (MP_MAX_PLAYERS)`,
  )
})

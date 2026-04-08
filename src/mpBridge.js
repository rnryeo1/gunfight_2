/**
 * 실시간 P2P 릴레이 (방당 다수 클라이언트). 서버: npm run mp-server
 */
export function createMpBridge(wsUrl, roomId, handlers) {
  let ws = null
  let slot = null
  const { onWelcome, onPeer, onClose, onError } = handlers || {}

  function connect() {
    ws = new WebSocket(wsUrl)
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', room: roomId }))
    }
    ws.onmessage = (ev) => {
      let m
      try {
        m = JSON.parse(ev.data)
      } catch {
        return
      }
      if (m.type === 'welcome') {
        slot = m.slot
        onWelcome?.(m)
      }
      if (m.type === 'peer' && m.payload !== undefined) onPeer?.(m.from, m.payload)
      if (m.type === 'peer_joined') onPeer?.(-1, { kind: '_peer_joined', slot: m.slot })
      if (m.type === 'peer_left') {
        onPeer?.(-1, { kind: '_peer_left', slot: m.slot })
      }
      if (m.type === 'room_full') onError?.(new Error('room_full'))
    }
    ws.onclose = () => onClose?.()
    ws.onerror = () => onError?.(new Error('ws_error'))
  }

  return {
    connect,
    getSlot: () => slot,
    send(payload) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'relay', payload }))
      }
    },
    close() {
      ws?.close()
      ws = null
    },
  }
}

export type PeerRole = 'host' | 'viewer'

export type Peer = { id: string; name: string; role: PeerRole }

export type ServerMessage =
  | { type: 'joined'; self: Peer; room: { code: string; hostId: string | null; live: boolean }; peers: Peer[] }
  | { type: 'peer-joined'; peer: Peer }
  | { type: 'peer-left'; id: string }
  | { type: 'chat'; from: string; name: string; text: string; ts: number }
  | { type: 'signal'; from: string; data: unknown }
  | { type: 'live'; live: boolean; from: string }
  | { type: 'room-closed' }
  | { type: 'error'; message: string }

export type ConnStatus = 'open' | 'closed'

export function signalingUrl(): string {
  const explicit = import.meta.env.VITE_SIGNALING_URL as string | undefined
  if (explicit) return explicit

  const secure = location.protocol === 'https:'
  const servedByApp = location.port === '' || location.port === '8787'
  const hostPart = servedByApp ? location.host : `${location.hostname}:8787`
  return `${secure ? 'wss' : 'ws'}://${hostPart}/ws`
}

export class Signaling {
  private ws: WebSocket | null = null

  constructor(
    private url: string,
    private onMessage: (message: ServerMessage) => void,
    private onStatus: (status: ConnStatus) => void,
  ) {
    this.open()
  }

  private open() {
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.onopen = () => this.onStatus('open')
    ws.onmessage = (event) => {
      try {
        this.onMessage(JSON.parse(event.data) as ServerMessage)
      } catch {
        /* mensagem inválida — ignora */
      }
    }
    ws.onclose = () => this.onStatus('closed')
    ws.onerror = () => this.onStatus('closed')
  }

  send(message: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message))
  }

  close() {
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      ws.close()
    }
  }
}

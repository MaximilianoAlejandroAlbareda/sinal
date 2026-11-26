import { useCallback, useEffect, useRef, useState } from 'react'
import { Signaling, signalingUrl, type Peer, type ServerMessage } from './signaling'

export type ChatMessage = {
  id: string
  name: string
  text: string
  ts: number
  self: boolean
  system?: boolean
}

export type RoomState = 'connecting' | 'joined' | 'error' | 'closed'

export type PeerStat = {
  id: string
  kbps: number
  fps: number
  width: number
  height: number
  rtt: number | null
  limiter: string
}

export type StreamStats = {
  outKbps: number
  capture: { width: number; height: number; fps: number } | null
  peers: PeerStat[]
}

const EMPTY_STATS: StreamStats = { outKbps: 0, capture: null, peers: [] }

// Cada espectador custa um upload completo do anfitrião (mesh P2P): com mais gente
// na sala a qualidade por pessoa precisa cair, senão a banda estoura e todos travam.
function viewerProfile(viewers: number) {
  if (viewers <= 1) return { maxBitrate: 8_000_000, maxHeight: 0 }
  if (viewers === 2) return { maxBitrate: 6_000_000, maxHeight: 1080 }
  if (viewers === 3) return { maxBitrate: 4_000_000, maxHeight: 900 }
  return { maxBitrate: 2_500_000, maxHeight: 720 }
}

function rtcConfig(): RTCConfiguration {
  const iceServers: RTCIceServer[] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ]
  const turnUrl = import.meta.env.VITE_TURN_URL as string | undefined
  if (turnUrl) {
    iceServers.push({
      urls: turnUrl,
      username: import.meta.env.VITE_TURN_USER as string | undefined,
      credential: import.meta.env.VITE_TURN_CREDENTIAL as string | undefined,
    })
  }
  return { iceServers, bundlePolicy: 'max-bundle' }
}

type SignalPayload = {
  kind: 'offer' | 'answer' | 'candidate' | 'request'
  sdp?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
}

export function useRoom(room: string, name: string, isHost: boolean) {
  const [state, setState] = useState<RoomState>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [selfId, setSelfId] = useState<string | null>(null)
  const [peers, setPeers] = useState<Peer[]>([])
  const [live, setLive] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [hostId, setHostId] = useState<string | null>(null)
  const [stats, setStats] = useState<StreamStats>(EMPTY_STATS)

  const sigRef = useRef<Signaling | null>(null)
  const selfIdRef = useRef<string | null>(null)
  const peersRef = useRef<Map<string, Peer>>(new Map())
  const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const localStreamRef = useRef<MediaStream | null>(null)
  const candidateQueue = useRef<Map<string, RTCIceCandidateInit[]>>(new Map())
  const unpublishRef = useRef<() => void>(() => {})
  const hostIdRef = useRef<string | null>(null)
  const retriesRef = useRef(0)

  const send = useCallback((message: Record<string, unknown>) => {
    sigRef.current?.send(message)
  }, [])

  const logSystem = useCallback((text: string) => {
    setMessages((prev) => [
      ...prev,
      { id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: 'Sinal', text, ts: Date.now(), self: false, system: true },
    ])
  }, [])

  const flushCandidates = useCallback(async (peerId: string, pc: RTCPeerConnection) => {
    const queued = candidateQueue.current.get(peerId) ?? []
    candidateQueue.current.delete(peerId)
    for (const candidate of queued) {
      await pc.addIceCandidate(candidate).catch(() => {})
    }
  }, [])

  // Ajusta o que sai para um espectador: teto de banda e resolução conforme o
  // tamanho da sala, sem renegociar (setParameters vale na hora).
  const tuneSender = useCallback(async (sender: RTCRtpSender, viewers: number) => {
    const profile = viewerProfile(viewers)
    const settings = localStreamRef.current?.getVideoTracks()[0]?.getSettings()
    const sourceHeight = Number(settings?.height ?? 0)
    const scale = profile.maxHeight && sourceHeight > profile.maxHeight ? sourceHeight / profile.maxHeight : 1
    try {
      const params = sender.getParameters()
      params.encodings = params.encodings?.length ? params.encodings : [{}]
      params.encodings[0].maxBitrate = profile.maxBitrate
      params.encodings[0].maxFramerate = 60
      params.encodings[0].scaleResolutionDownBy = Math.max(1, Math.min(4, Math.round(scale * 100) / 100))
      // Prioriza fluidez: se a rede/CPU apertar, cai a resolução e mantém o framerate.
      params.degradationPreference = 'maintain-framerate'
      await sender.setParameters(params)
    } catch {
      /* alguns navegadores recusam — segue com o padrão */
    }
  }, [])

  const retune = useCallback(() => {
    const viewers = Math.max(1, pcsRef.current.size)
    for (const pc of pcsRef.current.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind === 'video') void tuneSender(sender, viewers)
      }
    }
  }, [tuneSender])

  const offerTo = useCallback(
    async (peerId: string) => {
      const stream = localStreamRef.current
      if (!stream) return
      if (peerId === selfIdRef.current) return

      const previous = pcsRef.current.get(peerId)
      if (previous) {
        previous.close()
        pcsRef.current.delete(peerId)
      }

      const pc = new RTCPeerConnection(rtcConfig())
      pcsRef.current.set(peerId, pc)

      for (const track of stream.getTracks()) pc.addTrack(track, stream)

      pc.onicecandidate = (event) => {
        if (!event.candidate) return
        send({ type: 'signal', to: peerId, data: { kind: 'candidate', candidate: event.candidate.toJSON() } })
      }

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      const videoSender = pc.getSenders().find((item) => item.track?.kind === 'video')
      if (videoSender) await tuneSender(videoSender, Math.max(1, pcsRef.current.size))

      send({ type: 'signal', to: peerId, data: { kind: 'offer', sdp: pc.localDescription } })
    },
    [send, tuneSender],
  )

  const handleSignal = useCallback(
    async (from: string, data: unknown) => {
      const payload = data as SignalPayload
      if (!payload || typeof payload.kind !== 'string') return
      if (from === selfIdRef.current) return

      if (payload.kind === 'request') {
        if (localStreamRef.current) void offerTo(from)
        return
      }

      if (payload.kind === 'offer' && payload.sdp) {
        const previous = pcsRef.current.get(from)
        if (previous) {
          previous.close()
          pcsRef.current.delete(from)
        }

        const pc = new RTCPeerConnection(rtcConfig())
        pcsRef.current.set(from, pc)

        pc.onicecandidate = (event) => {
          if (!event.candidate) return
          send({ type: 'signal', to: from, data: { kind: 'candidate', candidate: event.candidate.toJSON() } })
        }

        pc.ontrack = (event) => {
          const stream = event.streams[0]
          if (!stream) return
          // Áudio e vídeo chegam em eventos separados; trocar o srcObject a cada
          // track reinicia o elemento de vídeo no meio da transmissão.
          setRemoteStream((prev) => (prev && prev.id === stream.id ? prev : stream))
        }

        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'connected') {
            retriesRef.current = 0
            return
          }
          if (pc.connectionState !== 'failed') return
          if (isHost || !hostIdRef.current || retriesRef.current >= 3) return
          retriesRef.current += 1
          send({ type: 'signal', to: hostIdRef.current, data: { kind: 'request' } })
        }

        await pc.setRemoteDescription(payload.sdp)
        await flushCandidates(from, pc)

        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        send({ type: 'signal', to: from, data: { kind: 'answer', sdp: pc.localDescription } })
        return
      }

      const pc = pcsRef.current.get(from)
      if (!pc) return

      if (payload.kind === 'answer' && payload.sdp) {
        await pc.setRemoteDescription(payload.sdp)
        await flushCandidates(from, pc)
        return
      }

      if (payload.kind === 'candidate' && payload.candidate) {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(payload.candidate).catch(() => {})
        } else {
          const queued = candidateQueue.current.get(from) ?? []
          queued.push(payload.candidate)
          candidateQueue.current.set(from, queued)
        }
      }
    },
    [flushCandidates, offerTo, send, isHost],
  )

  const unpublish = useCallback(() => {
    for (const pc of pcsRef.current.values()) pc.close()
    pcsRef.current.clear()
    candidateQueue.current.clear()

    const stream = localStreamRef.current
    localStreamRef.current = null
    stream?.getTracks().forEach((track) => track.stop())

    setLocalStream(null)
    setLive(false)
    send({ type: 'live', live: false })
  }, [send])

  useEffect(() => {
    unpublishRef.current = unpublish
  }, [unpublish])

  const publish = useCallback(
    (stream: MediaStream) => {
      localStreamRef.current = stream
      setLocalStream(stream)
      stream.getVideoTracks().forEach((track) => {
        // "motion" = jogo/vídeo em movimento; o encoder prefere fluidez a detalhe fino.
        track.contentHint = 'motion'
        track.addEventListener('ended', () => unpublishRef.current())
      })
      send({ type: 'live', live: true })
      setLive(true)
      for (const peerId of peersRef.current.keys()) void offerTo(peerId)
    },
    [offerTo, send],
  )

  const replaceCapture = useCallback(
    (stream: MediaStream) => {
      const previous = localStreamRef.current
      if (!previous) {
        publish(stream)
        return
      }

      const video = stream.getVideoTracks()[0]
      const audio = stream.getAudioTracks()[0]
      if (video) {
        video.contentHint = 'motion'
        video.addEventListener('ended', () => unpublishRef.current())
      }

      localStreamRef.current = stream
      setLocalStream(stream)

      // Troca a track sem renegociar: o espectador não vê o vídeo parar.
      for (const pc of pcsRef.current.values()) {
        for (const sender of pc.getSenders()) {
          if (sender.track?.kind === 'video' && video) void sender.replaceTrack(video).catch(() => {})
          if (sender.track?.kind === 'audio' && audio) void sender.replaceTrack(audio).catch(() => {})
        }
      }

      previous.getTracks().forEach((track) => track.stop())
    },
    [publish],
  )

  const sendChat = useCallback(
    (text: string) => {
      const clean = text.trim()
      if (!clean) return
      send({ type: 'chat', text: clean })
    },
    [send],
  )

  useEffect(() => {
    const signaling = new Signaling(
      signalingUrl(),
      (message: ServerMessage) => {
        switch (message.type) {
          case 'joined':
            selfIdRef.current = message.self.id
            setSelfId(message.self.id)
            setHostId(message.room.hostId)
            hostIdRef.current = message.room.hostId
            const others = message.peers.filter((peer) => peer.id !== message.self.id)
            peersRef.current = new Map(others.map((peer) => [peer.id, peer]))
            setPeers(others)
            setLive(message.room.live)
            setState('joined')
            logSystem(`Você entrou na sala ${message.room.code}.`)
            break

          case 'peer-joined':
            peersRef.current.set(message.peer.id, message.peer)
            setPeers([...peersRef.current.values()])
            logSystem(`${message.peer.name} entrou na sala.`)
            if (localStreamRef.current) {
              void offerTo(message.peer.id)
              retune()
            }
            break

          case 'peer-left': {
            const gone = peersRef.current.get(message.id)
            peersRef.current.delete(message.id)
            setPeers([...peersRef.current.values()])
            const pc = pcsRef.current.get(message.id)
            if (pc) {
              pc.close()
              pcsRef.current.delete(message.id)
            }
            if (gone) logSystem(`${gone.name} saiu da sala.`)
            retune()
            break
          }

          case 'chat':
            setMessages((prev) => [
              ...prev,
              {
                id: `m-${message.ts}-${message.from}`,
                name: message.name,
                text: message.text,
                ts: message.ts,
                self: message.from === selfIdRef.current,
              },
            ])
            break

          case 'live':
            setLive(message.live)
            if (!message.live) {
              setRemoteStream(null)
              for (const pc of pcsRef.current.values()) pc.close()
              pcsRef.current.clear()
            }
            break

          case 'signal':
            void handleSignal(message.from, message.data)
            break

          case 'room-closed':
            setState('closed')
            break

          case 'error':
            setError(message.message)
            setState('error')
            break
        }
      },
      (status) => {
        if (status === 'open') {
          sigRef.current?.send({ type: 'join', room, name, role: isHost ? 'host' : 'viewer' })
        }
      },
    )

    sigRef.current = signaling

    return () => {
      signaling.close()
      for (const pc of pcsRef.current.values()) pc.close()
      pcsRef.current.clear()
      localStreamRef.current?.getTracks().forEach((track) => track.stop())
      localStreamRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, name, isHost])

  // Amostra a cada segundo o que está saindo de verdade para cada espectador.
  useEffect(() => {
    if (!live) {
      setStats(EMPTY_STATS)
      return
    }

    let stopped = false
    const previous = new Map<string, { bytes: number; at: number }>()

    const sample = async () => {
      const rows: PeerStat[] = []
      let total = 0

      for (const [peerId, pc] of pcsRef.current) {
        if (pc.connectionState !== 'connected') continue
        let report: RTCStatsReport
        try {
          report = await pc.getStats()
        } catch {
          continue
        }

        const byId = new Map<string, any>()
        report.forEach((entry) => byId.set(entry.id, entry))
        const video = [...byId.values()].find((entry) => entry.type === 'outbound-rtp' && entry.kind === 'video')
        if (!video) continue

        const bytes = Number(video.bytesSent ?? 0)
        const at = Number(video.timestamp ?? performance.now())
        const last = previous.get(peerId)
        const kbps = last && at > last.at ? Math.max(0, ((bytes - last.bytes) * 8) / (at - last.at)) : 0
        previous.set(peerId, { bytes, at })
        total += kbps

        const transport = [...byId.values()].find((entry) => entry.type === 'transport')
        const pair = transport?.selectedCandidatePairId ? byId.get(transport.selectedCandidatePairId) : null

        rows.push({
          id: peerId,
          kbps: Math.round(kbps),
          fps: Math.round(Number(video.framesPerSecond ?? 0)),
          width: Number(video.frameWidth ?? 0),
          height: Number(video.frameHeight ?? 0),
          rtt: typeof pair?.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null,
          limiter: String(video.qualityLimiterReason ?? ''),
        })
      }

      if (stopped) return

      const settings = localStreamRef.current?.getVideoTracks()[0]?.getSettings()
      setStats({
        outKbps: Math.round(total),
        capture:
          settings?.width && settings?.height
            ? { width: settings.width, height: settings.height, fps: Math.round(settings.frameRate ?? 0) }
            : null,
        peers: rows,
      })
    }

    void sample()
    const timer = window.setInterval(() => void sample(), 1000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [live])

  return {
    state,
    error,
    selfId,
    hostId,
    peers,
    live,
    messages,
    remoteStream,
    localStream,
    stats,
    publish,
    unpublish,
    replaceCapture,
    sendChat,
  }
}

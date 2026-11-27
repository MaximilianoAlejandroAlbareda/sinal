import { useEffect, useRef, useState } from 'react'
import { publicAppUrl } from '../lib/signaling'
import { boostAudio, type AudioChain } from '../lib/audio'
import { startProcessAudio, type ProcessAudio } from '../lib/processAudio'
import { useRoom } from '../lib/useRoom'
import type { AudioProcess, CaptureSource } from '../env'
import { Logo } from './Home'

type Props = { code: string; isHost: boolean }

// De onde vem o som transmitido: um aplicativo específico (o do que está sendo
// compartilhado), a saída toda do Windows, ou nada.
type AudioMode = { kind: 'app'; pid: number } | { kind: 'system' } | { kind: 'none' }

// resizeMode: 'none' pede para o navegador não encaixar a fonte num tamanho fixo.
// Sem isso, quando a janela capturada muda de formato (ex.: vídeo em tela cheia) o
// Chromium recorta a imagem para caber no enquadramento antigo — some a parte de baixo.
const CAPTURE_VIDEO = { frameRate: { ideal: 60, max: 60 }, resizeMode: 'none' } as unknown as MediaTrackConstraints

// Áudio do sistema não é voz: os filtros de voz do Chromium (cancela eco, corta
// ruído, ajusta ganho) abafam música e som de jogo. Pedimos a captura crua.
const CAPTURE_AUDIO = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 2,
} as unknown as MediaTrackConstraints

export default function Room({ code, isHost }: Props) {
  const [name, setName] = useState(() => localStorage.getItem('sinal:nome') ?? '')
  const [draft, setDraft] = useState('')

  if (!name) {
    return (
      <div className="home">
        <div className="home-glow" aria-hidden="true" />
        <div className="card gate">
          <Logo />
          <h2>Entrando na sala {code}</h2>
          <p className="muted">Como você quer aparecer para o pessoal?</p>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && draft.trim()) {
                localStorage.setItem('sinal:nome', draft.trim().slice(0, 24))
                setName(draft.trim().slice(0, 24))
              }
            }}
            placeholder="Seu nome"
            maxLength={24}
            autoFocus
          />
          <button
            className="button primary large"
            onClick={() => {
              const clean = draft.trim().slice(0, 24)
              if (!clean) return
              localStorage.setItem('sinal:nome', clean)
              setName(clean)
            }}
          >
            Entrar na sala
          </button>
        </div>
      </div>
    )
  }

  return <RoomView code={code} name={name} isHost={isHost} />
}

function RoomView({ code, name, isHost }: { code: string; name: string; isHost: boolean }) {
  const { state, error, peers, live, messages, remoteStream, localStream, publish, unpublish, replaceCapture, sendChat, selfId, stats } =
    useRoom(code, name, isHost)

  const [chatDraft, setChatDraft] = useState('')
  const [picker, setPicker] = useState<CaptureSource[] | null>(null)
  const [includeAudio, setIncludeAudio] = useState(true)
  const [volume, setVolume] = useState(1)
  const lastVolumeRef = useRef(1)
  const [hasAudio, setHasAudio] = useState(false)
  const [frozen, setFrozen] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [shareError, setShareError] = useState('')
  const [lan, setLan] = useState<{ host: string; port: number } | null>(null)
  const [audioWarning, setAudioWarning] = useState('')
  const [audioApps, setAudioApps] = useState<AudioProcess[]>([])
  const [audioChoice, setAudioChoice] = useState('auto')
  const audioCheckRef = useRef<{ timer: number; ctx: AudioContext } | null>(null)
  const audioChainRef = useRef<AudioChain | null>(null)
  const processAudioRef = useRef<ProcessAudio | null>(null)
  const audioModeRef = useRef<AudioMode>({ kind: 'none' })

  const videoRef = useRef<HTMLVideoElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const sourceIdRef = useRef<string | null>(null)
  const sourceNameRef = useRef('')
  const geometryRef = useRef('')
  const lastRefitRef = useRef(0)
  const refitRef = useRef<() => void>(() => {})
  const sentRef = useRef({ frames: -1, changedAt: 0, peers: 0 })
  const refitsRef = useRef<number[]>([])

  const stream = isHost ? localStream : remoteStream
  const sharing = Boolean(localStream)

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream
  }, [stream])

  // O volume vive no elemento de vídeo e não sobrevive à troca de stream: sem
  // reaplicar, um <video> recém-criado voltaria a tocar a 100%.
  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume
  }, [volume, stream])

  // A track de áudio chega em um evento separado do vídeo e pode nem existir: sem
  // isso o botão de som ficava ativo sem nada para silenciar.
  useEffect(() => {
    if (!stream) {
      setHasAudio(false)
      return
    }
    const sync = () => setHasAudio(stream.getAudioTracks().length > 0)
    sync()
    stream.addEventListener('addtrack', sync)
    stream.addEventListener('removetrack', sync)
    return () => {
      stream.removeEventListener('addtrack', sync)
      stream.removeEventListener('removetrack', sync)
    }
  }, [stream])

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === frameRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
      return
    }
    void frameRef.current?.requestFullscreen?.().catch(() => {})
  }

  // Clicar no ícone alterna mudo e o último volume usado, como no player do YouTube.
  function toggleMute() {
    setVolume((current) => {
      if (current > 0) {
        lastVolumeRef.current = current
        return 0
      }
      return lastVolumeRef.current > 0 ? lastVolumeRef.current : 1
    })
  }

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  // A lista de janelas do Windows muda com o seletor aberto: janela minimizada sai
  // da lista e só volta quando é restaurada/repintada. Atualiza sozinha para o
  // usuário não precisar fechar e abrir o seletor de novo.
  const pickerOpen = picker !== null
  useEffect(() => {
    if (!pickerOpen) return
    let alive = true
    const refresh = async () => {
      if (!window.sinal) return
      try {
        const sources = await window.sinal.listSources()
        if (!alive) return
        setPicker((current) => {
          if (!current) return current
          const next = current
            .filter((source) => sources.some((item) => item.id === source.id))
            .map((source) => sources.find((item) => item.id === source.id) ?? source)
          for (const source of sources) {
            if (!next.some((item) => item.id === source.id)) next.push(source)
          }
          const same =
            next.length === current.length &&
            next.every(
              (source, index) => source.id === current[index].id && source.thumbnail === current[index].thumbnail,
            )
          return same ? current : next
        })
      } catch {
        // a próxima atualização tenta de novo
      }
    }
    const timer = window.setInterval(refresh, 1500)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [pickerOpen])

  // Se a fonte mudar de formato no meio da transmissão (tela cheia, rotação), recaptura e
  // troca a track para o enquadramento voltar ao normal. Só a PROPORÇÃO importa: um jogo
  // que troca de resolução mantendo 16:9 continua enquadrado, e recapturar ali custava um
  // engasgo (troca de track + novo keyframe) sem corrigir nada.
  useEffect(() => {
    const element = videoRef.current
    if (!element || !isHost || !localStream || !window.sinal) return

    const check = () => {
      if (!element.videoWidth || !element.videoHeight) return
      const aspect = element.videoWidth / element.videoHeight
      const previous = Number(geometryRef.current)
      geometryRef.current = String(aspect)
      if (previous && Math.abs(aspect - previous) / previous > 0.02) void refit()
    }

    // Espera a janela parar de mudar de tamanho: entrar/sair da tela cheia mexe no tamanho
    // em vários passos e cada recaptura no meio do caminho reiniciava o vídeo.
    let timer = 0
    const onResize = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(check, 400)
    }

    element.addEventListener('resize', onResize)
    check()
    return () => {
      window.clearTimeout(timer)
      element.removeEventListener('resize', onResize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, localStream])

  // A captura de janela no Windows (Windows Graphics Capture) só enxerga o que o DWM
  // compõe. Um jogo em tela cheia exclusiva apresenta direto no monitor, então a track
  // continua "ao vivo" mas sem frames novos: quem assiste vê a última imagem congelada.
  // Nenhuma API de usuário resolve isso (nem OBS nem Discord capturam FSE sem injetar
  // código no jogo) — o que dá é avisar e voltar sozinho quando o jogo sair do modo.
  //
  // O teste é sobre os frames do ENCODER (framesEncoded dos senders), não sobre o preview:
  // com a janela do Sinal atrás do jogo o navegador para de compor o <video> e ele parece
  // parado mesmo com o espectador recebendo imagem normalmente — isso dava alarme falso.
  useEffect(() => {
    const state = sentRef.current
    // Espectador entrou ou saiu: recomeça a contagem para não acusar congelamento no
    // primeiro segundo de quem acabou de conectar.
    if (stats.connectedPeers !== state.peers) state.changedAt = performance.now()
    state.peers = stats.connectedPeers
    if (stats.sentFrames !== state.frames) {
      state.frames = stats.sentFrames
      state.changedAt = performance.now()
    }
  }, [stats])

  useEffect(() => {
    sentRef.current.changedAt = performance.now()
    if (!isHost || !sharing) {
      setFrozen(false)
      return
    }

    const timer = window.setInterval(() => {
      const state = sentRef.current
      // Sem espectador conectado não há frames para contar: não é congelamento.
      const stalled = state.peers > 0 && performance.now() - state.changedAt > 4000
      setFrozen((previous) => (previous === stalled ? previous : stalled))
    }, 500)

    return () => {
      window.clearInterval(timer)
      setFrozen(false)
    }
  }, [isHost, sharing])

  // Quem abre o link está em outra máquina: o endereço tem que ser o IPv4 da rede
  // local, senão o convidado recebe um 127.0.0.1 que só existe no PC do anfitrião.
  useEffect(() => {
    if (!isHost || !window.sinal?.lanInfo) return
    let cancelled = false
    void window.sinal
      .lanInfo()
      .then((info) => {
        if (cancelled || !info?.addresses?.length) return
        setLan({ host: info.addresses[0], port: info.port || Number(location.port) || 8787 })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [isHost])

  // Com a sinalização publicada configurada, o convite é a página do Render — serve
  // para qualquer rede. O link da LAN fica como atalho para quem está no mesmo Wi-Fi.
  const publicUrl = publicAppUrl()
  const lanLink = lan ? `http://${lan.host}:${lan.port}${location.pathname}#/sala/${code}` : null
  const viewerLink = publicUrl
    ? `${publicUrl}/#/sala/${code}`
    : (lanLink ?? `${location.origin}${location.pathname}#/sala/${code}`)

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(viewerLink)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setShareError(viewerLink)
    }
  }

  // O loopback do Windows captura a saída padrão; se ela for um dispositivo
  // virtual (Sonar, Voicemod, NVIDIA) ou estiver sem volume, sai silêncio e o
  // espectador não ouve nada. Medir o nível logo após publicar torna isso visível.
  function checkAudio(stream: MediaStream, sourceKind?: 'app' | 'system') {
    const running = audioCheckRef.current
    if (running) {
      window.clearInterval(running.timer)
      void running.ctx.close()
      audioCheckRef.current = null
    }

    const track = stream.getAudioTracks()[0]
    if (!track) {
      setAudioWarning('A transmissão saiu sem áudio. Marque "Incluir áudio" e transmita de novo.')
      return
    }

    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    ctx.createMediaStreamSource(new MediaStream([track])).connect(analyser)
    const buffer = new Float32Array(analyser.fftSize)
    const started = Date.now()
    let peak = 0

    const timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(buffer)
      for (const value of buffer) peak = Math.max(peak, Math.abs(value))
      if (Date.now() - started < 5000) return
      window.clearInterval(timer)
      audioCheckRef.current = null
      void ctx.close()
      const isSystem = sourceKind === 'system'
      setAudioWarning(
        isSystem && peak < 0.002
          ? 'O áudio do sistema está saindo mudo. O Windows captura o dispositivo de saída padrão: se ele for virtual (SteelSeries Sonar, Voicemod, NVIDIA) ou estiver sem volume, os espectadores não ouvem nada. Troque a saída padrão para o fone ou a caixa e transmita de novo.'
          : '',
      )
    }, 200)

    audioCheckRef.current = { timer, ctx }
  }

  // Publica o áudio já ampliado: o que sai para os espectadores tem nível audível
  // e silêncio de verdade nas pausas, sem depender do dispositivo de saída do PC.
  function withBoostedAudio(captured: MediaStream, onSwitch?: () => void): MediaStream {
    audioChainRef.current?.dispose()
    audioChainRef.current = null
    const chain = boostAudio(captured, onSwitch)
    if (!chain) return captured
    audioChainRef.current = chain
    return new MediaStream([...captured.getVideoTracks(), ...chain.stream.getAudioTracks()])
  }

  function releaseAudio() {
    audioChainRef.current?.dispose()
    audioChainRef.current = null
    processAudioRef.current?.dispose()
    processAudioRef.current = null
  }

  // Decide de onde vem o som: por padrão o aplicativo da janela compartilhada, que é
  // o que impede o espectador de ouvir a call do Discord junto com o vídeo.
  function resolveAudioMode(sourceName: string): AudioMode {
    if (!includeAudio) return { kind: 'none' }
    if (audioChoice === 'system') return { kind: 'system' }
    if (audioChoice === 'none') return { kind: 'none' }
    if (audioChoice !== 'auto') {
      const pid = Number(audioChoice)
      if (Number.isFinite(pid)) return { kind: 'app', pid }
    }
    const title = sourceName.toLowerCase()
    const match = audioApps.find((app) => {
      const name = app.name.toLowerCase().replace(/\.exe$/, '')
      if (!name) return false
      if (title.includes(name)) return true
      const first = name.split(' ')[0]
      return first.length > 3 && title.includes(first)
    })
    // Sem correspondência, fica sem áudio: puxar o som do sistema inteiro traria
    // justamente a call e os outros apps que a captura por aplicativo evita.
    return match ? { kind: 'app', pid: match.pid } : { kind: 'none' }
  }

  async function captureSystem(sourceId: string, audio: boolean): Promise<MediaStream> {
    await window.sinal?.selectSource(sourceId, audio)
    const captured = await navigator.mediaDevices.getDisplayMedia({
      video: CAPTURE_VIDEO,
      audio: audio ? CAPTURE_AUDIO : false,
    })
    if (audio) checkAudio(captured, 'system')
    return withBoostedAudio(captured, () => {})
  }

  async function captureSelection(sourceId: string, sourceName: string): Promise<MediaStream> {
    let mode = resolveAudioMode(sourceName)
    // O nome só casa quando o título da janela traz o nome do app: o Spotify mostra o
    // nome da faixa, jogo mostra o nome da cena, e aí o automático desistia. O pid
    // dono da janela acerta nos dois casos.
    if (includeAudio && audioChoice === 'auto') {
      try {
        const detected = await window.sinal?.resolveAudioForSource?.(sourceId)
        if (detected) mode = { kind: 'app', pid: detected }
      } catch {
        /* sem o mapa de janelas: segue pelo nome */
      }
    }
    audioModeRef.current = mode
    releaseAudio()

    // Modo automático sem aplicativo correspondente: antes saía mudo e sem aviso.
    if (mode.kind === 'none' && includeAudio && audioChoice === 'auto') {
      setAudioWarning(
        'A transmissão saiu sem som: a janela escolhida não bateu com nenhum aplicativo tocando áudio. Em "Áudio de", escolha o app (ou "Todo o som do sistema") e transmita de novo.',
      )
    }

    if (mode.kind === 'app') {
      await window.sinal?.selectSource(sourceId, false)
      const video = await navigator.mediaDevices.getDisplayMedia({ video: CAPTURE_VIDEO, audio: false })
      const processAudio = await startProcessAudio(mode.pid)
      if (processAudio) {
        processAudioRef.current = processAudio
        checkAudio(processAudio.stream, 'app')
        const boosted = withBoostedAudio(processAudio.stream, () => {})
        return new MediaStream([...video.getVideoTracks(), ...boosted.getAudioTracks()])
      }
      // Sem captura por aplicativo, não cai para o som do sistema: seria justamente
      // o mix com a call e o resto do PC. Melhor transmitir só a imagem.
      audioModeRef.current = { kind: 'none' }
      setAudioWarning(
        'Não foi possível capturar o áudio desse aplicativo. A transmissão saiu sem som — confira em "Áudio de" se ele aparece tocando e transmita de novo.',
      )
      return new MediaStream([...video.getVideoTracks()])
    }

    return captureSystem(sourceId, mode.kind === 'system')
  }

  async function startSharing() {
    setShareError('')
    setAudioWarning('')
    try {
      if (window.sinal?.isDesktop) {
        const [sources, apps] = await Promise.all([
          window.sinal.listSources(),
          window.sinal.listAudioProcesses().catch(() => [] as AudioProcess[]),
        ])
        setAudioApps(apps)
        setPicker(sources)
        return
      }
      const captured = await navigator.mediaDevices.getDisplayMedia({
        video: CAPTURE_VIDEO,
        audio: CAPTURE_AUDIO,
      })
      if (includeAudio && captured.getAudioTracks().length === 0) {
        setAudioWarning(
          'A transmissão saiu sem áudio: marque "compartilhar o som da aba" na janela do navegador e transmita de novo.',
        )
      }
      publish(withBoostedAudio(captured, () => {}))
    } catch (err) {
      const failure = err as Error
      if (failure.name !== 'NotAllowedError') setShareError(`Não foi possível capturar a tela: ${failure.message}`)
    }
  }

  async function confirmSource(source: CaptureSource) {
    setPicker(null)
    if (!window.sinal) return
    try {
      const stream = await captureSelection(source.id, source.name)
      sourceIdRef.current = source.id
      sourceNameRef.current = source.name
      publish(stream)
    } catch (err) {
      const failure = err as Error
      if (failure.name !== 'NotAllowedError') setShareError(`Não foi possível capturar a tela: ${failure.message}`)
    }
  }

  async function refit() {
    const sourceId = sourceIdRef.current
    if (!sourceId || !window.sinal?.isDesktop) return
    const now = Date.now()
    if (now - lastRefitRef.current < 1500) return
    // Recapturar reinicia a track (e pede keyframe novo). Se a fonte oscilar de formato,
    // isso viraria uma cascata de engasgos: depois de 3 recapturas em 10 s, para de tentar
    // até o formato ficar estável.
    const recent = refitsRef.current.filter((at) => now - at < 10_000)
    if (recent.length >= 3) return
    recent.push(now)
    refitsRef.current = recent
    lastRefitRef.current = now
    // A janela mudou de formato, mas o áudio do aplicativo não depende disso:
    // recapturar só o vídeo mantém o som no ar. Refazer o caminho completo aqui
    // reiniciava a captura do processo e cortava o áudio de quem está assistindo.
    const audio = localStream?.getAudioTracks()[0]
    const keepAudio = audioModeRef.current.kind === 'app' && audio?.readyState === 'live' ? audio : null
    try {
      if (keepAudio) {
        await window.sinal?.selectSource(sourceId, false)
        const video = await navigator.mediaDevices.getDisplayMedia({ video: CAPTURE_VIDEO, audio: false })
        const videoTrack = video.getVideoTracks()[0]
        if (!videoTrack) return
        replaceCapture(new MediaStream([videoTrack, keepAudio]))
        // A track nova já entra com o formato certo: sem isso o próximo `resize` do
        // preview comparava com a proporção antiga e pedia outra recaptura.
        const settings = videoTrack.getSettings()
        if (settings.width && settings.height) geometryRef.current = String(settings.width / settings.height)
        return
      }
      const stream = await captureSelection(sourceId, sourceNameRef.current)
      replaceCapture(stream)
      const settings = stream.getVideoTracks()[0]?.getSettings()
      if (settings?.width && settings?.height) geometryRef.current = String(settings.width / settings.height)
    } catch {
      /* segue com a captura atual */
    }
  }

  // A janela compartilhada mudou de formato: o processo principal avisa para
  // recapturar antes que a imagem chegue cortada em quem está assistindo.
  useEffect(() => {
    refitRef.current = () => {
      void refit()
    }
  })

  useEffect(() => {
    if (!window.sinal?.onRefit) return
    return window.sinal.onRefit(() => refitRef.current())
  }, [])

  function stopSharing() {
    void window.sinal?.clearSource?.()
    const running = audioCheckRef.current
    if (running) {
      window.clearInterval(running.timer)
      void running.ctx.close()
      audioCheckRef.current = null
    }
    setAudioWarning('')
    releaseAudio()
    unpublish()
  }

  function leaveRoom() {
    void window.sinal?.clearSource?.()
    releaseAudio()
    unpublish()
    location.hash = ''
  }

  useEffect(
    () => () => {
      const running = audioCheckRef.current
      if (running) {
        window.clearInterval(running.timer)
        void running.ctx.close()
      }
      audioChainRef.current?.dispose()
      audioChainRef.current = null
    },
    [],
  )

  const overlays = state === 'error' || state === 'closed'

  return (
    <div className="room">
      <header className="topbar">
        <div className="topbar-left">
          <Logo />
          <span className="chip room-chip">SALA {code}</span>
        </div>

        <div className="topbar-right">
          <button className="button ghost" onClick={copyLink}>
            {copied ? 'Link copiado' : 'Copiar link'}
          </button>
          <button className="button ghost" onClick={leaveRoom}>
            Sair
          </button>
        </div>
      </header>

      <div className="layout">
        <main className="stage">
          <div ref={frameRef} className={`video-frame${live && stream ? ' is-live' : ''}`}>
            {/* O anfitrião já ouve o próprio áudio direto no sistema: tocar o preview
                aqui fazia o loopback recapturar esse som em laço (o retorno). */}
            {stream ? (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted={isHost || volume === 0}
              />
            ) : (
              <div className="empty-stage">
                <div className="pulse" aria-hidden="true" />
                <h2>{isHost ? 'Sua sala está pronta' : live ? 'Conectando ao vídeo...' : 'Aguardando transmissão'}</h2>
                <p>
                  {isHost
                    ? 'Mande o link para os amigos e clique em "Transmitir minha tela" para começar.'
                    : 'Quando o anfitrião começar a transmitir, a tela aparece aqui.'}
                </p>
              </div>
            )}

            {stream && (
              <div className="stage-tools">
                {/* Sem track de áudio não há o que silenciar: um botão ativo aqui só confundia. */}
                {!isHost && hasAudio && (
                  <div className={`volume${volume === 0 ? ' is-muted' : ''}`}>
                    <button
                      type="button"
                      className="volume-icon"
                      onClick={toggleMute}
                      title={volume === 0 ? 'Ativar som' : 'Silenciar'}
                      aria-label={volume === 0 ? 'Ativar som' : 'Silenciar'}
                    >
                      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                        <path d="M4 9.6h3.3L12 5.6v12.8L7.3 14.4H4z" fill="currentColor" />
                        {volume === 0 ? (
                          <path
                            d="M16 9.5l4.5 5M20.5 9.5L16 14.5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.7"
                            strokeLinecap="round"
                          />
                        ) : (
                          <>
                            <path
                              d={`M15.6 9.1a4.3 4.3 0 0 1 0 5.8`}
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.7"
                              strokeLinecap="round"
                            />
                            {volume > 0.5 && (
                              <path
                                d="M18.4 6.4a8.4 8.4 0 0 1 0 11.2"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.7"
                                strokeLinecap="round"
                              />
                            )}
                          </>
                        )}
                      </svg>
                    </button>
                    <input
                      type="range"
                      className="volume-slider"
                      min={0}
                      max={1}
                      step={0.01}
                      value={volume}
                      aria-label="Volume da transmissão"
                      onChange={(event) => setVolume(Number(event.target.value))}
                      style={{ ['--fill' as string]: `${volume * 100}%` } as React.CSSProperties}
                    />
                  </div>
                )}
                {!isHost && !hasAudio && (
                  <span className="stage-hint" title="O anfitrião está transmitindo sem áudio">
                    Sem áudio
                  </span>
                )}
                {/* A tela cheia vai no quadro, não no <video>: assim o som continua
                   acessível em vez dos controles nativos desabilitados. */}
                {!isHost && (
                  <button className="button ghost small" onClick={toggleFullscreen}>
                    {isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
                  </button>
                )}
              </div>
            )}

          </div>

          <div className="controls">
            <div className="controls-info">
              <span className={`status-dot${live ? ' on' : ''}`} aria-hidden="true" />
              {live ? 'Transmissão ao vivo' : 'Ninguém transmitindo'} · {peers.length + (selfId ? 1 : 0)} na sala
            </div>

            {isHost ? (
              sharing ? (
                <button className="button danger" onClick={stopSharing}>
                  Encerrar transmissão
                </button>
              ) : (
                <button className="button primary" onClick={startSharing}>
                  Transmitir minha tela
                </button>
              )
            ) : (
              <button className="button ghost" onClick={copyLink}>
                Convidar mais gente
              </button>
            )}
          </div>

          {isHost && (publicUrl || lanLink) && (
            <p className="invite">
              {publicUrl ? 'Link para convidados' : 'Na mesma rede'}: <code>{viewerLink}</code>
            </p>
          )}

          {isHost && publicUrl && lanLink && (
            <p className="invite">
              Na mesma rede: <code>{lanLink}</code>
            </p>
          )}

          {shareError && <p className="field-error pad">{shareError}</p>}
          {isHost && audioWarning && <p className="field-error pad">{audioWarning}</p>}
          {isHost && sharing && frozen && (
            <p className="field-error pad">
              Quem está assistindo parou de receber imagem. Se o jogo está em{' '}
              <strong>tela cheia exclusiva</strong>, o Windows não entrega essa imagem para a captura de
              janela (só o modo <strong>janela sem bordas</strong> é capturável). Coloque o jogo nesse modo e
              a imagem volta sozinha; se não voltar, encerre e transmita de novo.
            </p>
          )}
        </main>

        <aside className="sidebar">
          <section className="panel">
            <header className="panel-head">
              <span>Na sala</span>
              <span className="count">{peers.length + (selfId ? 1 : 0)}</span>
            </header>
            <ul className="people">
              <Person
                tag={isHost && sharing ? 'transmitindo' : 'você'}
                name={`${name} (você)`}
                role={isHost ? 'host' : 'viewer'}
              />
              {peers.map((peer) => (
                <Person
                  key={peer.id}
                  name={peer.name}
                  role={peer.role}
                  tag={peer.role === 'host' && live ? 'transmitindo' : 'espectador'}
                />
              ))}
            </ul>
          </section>

          {isHost && live && (
            <section className="panel">
              <header className="panel-head">
                <span>Transmissão</span>
                <span className="count">{formatRate(stats.outKbps)}</span>
              </header>
              <ul className="stats-list">
                {stats.capture && (
                  <li className="stat-row">
                    <span>Captura</span>
                    <span className="stat-value">
                      {stats.capture.width}×{stats.capture.height} · {stats.capture.fps} fps
                    </span>
                  </li>
                )}
                {stats.peers.length === 0 && (
                  <li className="stat-row">Aguardando espectador conectar…</li>
                )}
                {stats.peers.map((row) => (
                  <li key={row.id} className="stat-row">
                    <span>{peers.find((peer) => peer.id === row.id)?.name ?? 'Espectador'}</span>
                    <span className="stat-value">
                      {row.width}×{row.height} · {row.fps} fps · {formatRate(row.kbps)}
                      {row.rtt !== null ? ` · ${row.rtt} ms` : ''}
                      {row.limiter === 'cpu'
                        ? ' · CPU no limite'
                        : row.limiter === 'bandwidth'
                          ? ' · rede no limite'
                          : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="panel chat">
            <header className="panel-head">
              <span>Chat</span>
            </header>
            <div className="messages">
              {messages.map((message) => {
                return message.system ? (
                  <p key={message.id} className="system-message">
                    {message.text}
                  </p>
                ) : (
                  <div key={message.id} className={`message${message.self ? ' self' : ''}`}>
                    <div className="message-meta">
                      <strong>{message.self ? 'Você' : message.name}</strong>
                      <time>
                        {new Date(message.ts).toLocaleTimeString('pt-BR', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </div>
                    <p>{message.text}</p>
                  </div>
                )
              })}
              <div ref={chatEndRef} />
            </div>
            <form
              className="chat-form"
              onSubmit={(event) => {
                event.preventDefault()
                sendChat(chatDraft)
                setChatDraft('')
              }}
            >
              <input
                value={chatDraft}
                onChange={(event) => setChatDraft(event.target.value)}
                placeholder="Mandar mensagem"
                maxLength={800}
              />
              <button className="button primary small" type="submit" disabled={!chatDraft.trim()}>
                Enviar
              </button>
            </form>
          </section>
        </aside>
      </div>

      {overlays && (
        <div className="overlay">
          <div className="card narrow">
            <h2>{state === 'closed' ? 'Sala encerrada' : 'Não deu para entrar'}</h2>
            <p className="muted">
              {state === 'closed'
                ? 'O anfitrião saiu ou fechou a transmissão da sala.'
                : error ?? 'Sala não encontrada. Confira o link recebido.'}
            </p>
            <button className="button primary" onClick={() => (location.hash = '')}>
              Voltar ao início
            </button>
          </div>
        </div>
      )}

      {picker && (
        <div className="overlay">
          <div className="card wide">
            <h2>O que você quer transmitir?</h2>
            <p className="muted">
              Escolha a tela ou a janela do jogo. O som vem só do aplicativo escolhido abaixo: quem assiste
              não ouve o resto do PC nem a call. Janelas minimizadas não aparecem: restaure a janela para
              ela entrar na lista.
            </p>

            <div className="sources">
              {picker.map((source) => (
                <button key={source.id} className="source" onClick={() => confirmSource(source)}>
                  {source.thumbnail ? (
                    <img src={source.thumbnail} alt="" />
                  ) : (
                    <div className="source-fallback">Sem prévia</div>
                  )}
                  <span>{source.name}</span>
                </button>
              ))}
              {picker.length === 0 && <p className="muted">Nenhuma tela disponível para capturar.</p>}
            </div>

            <label className="checkbox">
              <input
                type="checkbox"
                checked={includeAudio}
                onChange={(event) => setIncludeAudio(event.target.checked)}
              />
              <span>Incluir áudio na transmissão</span>
            </label>

            {includeAudio && (
              <label className="audio-pick">
                <span>Áudio de</span>
                <select
                  value={audioChoice}
                  onChange={(event) => setAudioChoice(event.target.value)}
                >
                  <option value="auto">Automático (o aplicativo da janela)</option>
                  {audioApps.map((app) => (
                    <option key={app.pid} value={String(app.pid)}>
                      {app.name}
                    </option>
                  ))}
                  <option value="system">Todo o som do sistema</option>
                  <option value="none">Nada (só a imagem)</option>
                </select>
              </label>
            )}

            {includeAudio && audioApps.length === 0 && (
              <p className="muted">
                Nenhum aplicativo tocando som agora. Abra o vídeo ou o jogo e clique em transmitir de novo para
                escolher só o áudio dele.
              </p>
            )}

            <button className="button ghost" onClick={() => setPicker(null)}>
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function formatRate(kbps: number) {
  if (!kbps) return '0 kb/s'
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mb/s` : `${kbps} kb/s`
}

function Person({ name, role, tag }: { name: string; role: 'host' | 'viewer'; tag: string }) {
  return (
    <li className="person">
      <span className="avatar" aria-hidden="true">
        {name.slice(0, 1).toUpperCase()}
      </span>
      <span className="person-name">{name}</span>
      <span className={`tag${role === 'host' && tag === 'transmitindo' ? ' live' : ''}`}>{tag}</span>
    </li>
  )
}
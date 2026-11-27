import { useEffect, useRef, useState } from 'react'
import { publicAppUrl } from '../lib/signaling'
import { boostAudio, type AudioChain } from '../lib/audio'
import { startProcessAudio, type ProcessAudio } from '../lib/processAudio'
import { useRoom } from '../lib/useRoom'
import { AudioLevel } from '../lib/audio-level'
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
  const [muted, setMuted] = useState(false)
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
  const chatEndRef = useRef<HTMLDivElement>(null)
  const sourceIdRef = useRef<string | null>(null)
  const sourceNameRef = useRef('')
  const geometryRef = useRef('')
  const lastRefitRef = useRef(0)
  const refitRef = useRef<() => void>(() => {})

  const stream = isHost ? localStream : remoteStream
  const sharing = Boolean(localStream)

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream
  }, [stream])

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

  // Se a fonte mudar de formato no meio da transmissão (tela cheia, rotação, troca
  // de resolução), recaptura e troca a track para o enquadramento voltar ao normal.
  useEffect(() => {
    const element = videoRef.current
    if (!element || !isHost || !localStream || !window.sinal) return

    const check = () => {
      if (!element.videoWidth || !element.videoHeight) return
      const geometry = `${element.videoWidth}x${element.videoHeight}`
      if (geometryRef.current && geometryRef.current !== geometry) void refit()
      geometryRef.current = geometry
    }

    element.addEventListener('resize', check)
    check()
    return () => element.removeEventListener('resize', check)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, localStream])

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
    const mode = resolveAudioMode(sourceName)
    audioModeRef.current = mode
    releaseAudio()

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
    if (Date.now() - lastRefitRef.current < 1500) return
    lastRefitRef.current = Date.now()
    try {
      const stream = await captureSelection(sourceId, sourceNameRef.current)
      replaceCapture(stream)
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
          <div className={`video-frame${live && stream ? ' is-live' : ''}`}>
            {/* O anfitrião já ouve o próprio áudio direto no sistema: tocar o preview
                aqui fazia o loopback recapturar esse som em laço (o retorno). */}
            {stream ? (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted={isHost || muted}
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
                {!isHost && (
                  <button className="button ghost small" onClick={() => setMuted((value) => !value)}>
                    {muted ? 'Ativar som' : 'Silenciar'}
                  </button>
                )}
                {/* Mostrar botão fullscreen apenas quando não estiver compartilhando um app específico
                   (exclusive fullscreen quebra a captura de app no Windows) */}
                {!isHost && audioModeRef.current?.kind !== 'app' && (
                  <button
                    className="button ghost small"
                    onClick={() => videoRef.current?.requestFullscreen?.().catch(() => {})}
                  >
                    Tela cheia
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Audio level meter visible only for viewers, not the host */}
          {!isHost && live && stream && (
            <div style={{ position: 'absolute', bottom: 8, right: 8, zIndex: 10 }}>
              <AudioLevel stream={stream} width={180} height={60} />
            </div>
          )}

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
                message.system ? (
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
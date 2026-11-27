import React, { useState, useRef, useEffect } from 'react'

type AudioLevelProps = {
  stream: MediaStream
  width?: number
  height?: number
  style?: React.CSSProperties
}

export function AudioLevel({ stream, width = 180, height = 60, style }: AudioLevelProps) {
  const [peaks, setPeaks] = useState<number[]>([])
  // Precisa ser estado: a track de áudio pode chegar depois do vídeo, e um ref
  // não re-renderiza — o medidor ficava preso em "sem áudio".
  const [hasTrack, setHasTrack] = useState(false)
  const hasTrackRef = useRef(false)
  hasTrackRef.current = hasTrack

  useEffect(() => {
    if (!stream) {
      setHasTrack(false)
      return
    }
    const sync = () => setHasTrack(stream.getAudioTracks().length > 0)
    sync()
    stream.addEventListener('addtrack', sync)
    stream.addEventListener('removetrack', sync)
    return () => {
      stream.removeEventListener('addtrack', sync)
      stream.removeEventListener('removetrack', sync)
    }
  }, [stream])

  useEffect(() => {
    let rafId = 0
    let cancelled = false
    const track = hasTrackRef.current ? stream?.getAudioTracks()[0] : null
    if (!track) {
      setPeaks([])
      return
    }

    const ctx = new AudioContext({ sampleRate: 48000 })
    // Criado fora de um gesto do usuário o contexto nasce suspenso e o analyser
    // devolve zeros: o medidor mostrava silêncio mesmo com som tocando.
    const resume = () => {
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    }
    resume()
    window.addEventListener('pointerdown', resume)
    window.addEventListener('keydown', resume)

    const input = ctx.createMediaStreamSource(new MediaStream([track]))
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.minDecibels = -90
    analyser.maxDecibels = -10
    analyser.smoothingTimeConstant = 0.8
    input.connect(analyser)

    const dataArray = new Uint8Array(analyser.frequencyBinCount)
    const render = () => {
      if (cancelled) return
      try {
        analyser.getByteFrequencyData(dataArray)
        const average = dataArray.reduce((a: number, b: number) => a + b, 0) / dataArray.length
        setPeaks(prev => [...prev.slice(-9), average]) // keeps last 10 values
      } catch (e) {
        // Erro ao ler dados (contexto fechado, etc.)
      }
      rafId = requestAnimationFrame(render)
    }

    render()

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
      window.removeEventListener('pointerdown', resume)
      window.removeEventListener('keydown', resume)
      input.disconnect()
      analyser.disconnect()
      void ctx.close().catch(() => {})
    }
  }, [stream, hasTrack])

  // Calcular altura máxima baseada nos picos
  const maxPeak = peaks.length > 0 ? Math.max(...peaks) : 0
  const barHeight = (maxPeak / 255) * height // Analyser retorna 0-255

  // Posiciona dentro do quadro do vídeo (.video-frame é position: relative)
  const containerStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: 8,
    right: 8,
    zIndex: 1000,
    width: `${width}px`,
    height: `${height}px`,
    ...style,
  }

  if (!hasTrack) {
    return (
      <div style={containerStyle}>
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: 'var(--panel-2)',
            borderRadius: 6,
            border: '1px solid rgba(255, 150, 150, 0.25)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
            color: '#ffb4b4',
            fontSize: 11,
            textAlign: 'center',
            padding: 4,
          }}
        >
          <strong style={{ fontSize: 11, letterSpacing: '0.06em' }}>SEM ÁUDIO</strong>
          <span style={{ opacity: 0.75 }}>o anfitrião transmite só a imagem</span>
        </div>
      </div>
    )
  }

  return (
    <div style={containerStyle}>
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          background: 'var(--panel-2)',
          borderRadius: 6,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'flex-end',
        }}
        title={maxPeak ? 'Nível de áudio da transmissão' : 'Nível de áudio da transmissão (silêncio)'}
      >
        <div
          style={{
            height: `${Math.max(3, barHeight)}px`,
            width: '100%',
            background: 'linear-gradient(to top, var(--accent) 0%, rgba(139, 92, 246, 0.35) 100%)',
            transition: 'height 80ms linear',
          }}
        />
      </div>
    </div>
  )
}

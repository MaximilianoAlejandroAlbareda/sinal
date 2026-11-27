import React, { useState, useRef, useEffect } from 'react'

type AudioLevelProps = {
  stream: MediaStream
  width?: number
  height?: number
  style?: React.CSSProperties
}

export function AudioLevel({ stream, width = 180, height = 60, style }: AudioLevelProps) {
  const [peaks, setPeaks] = useState<number[]>([])
  const hasTrackRef = useRef(false)

  useEffect(() => {
    let rafId = 0
    let cancelled = false
    const track = stream?.getAudioTracks()[0]
    hasTrackRef.current = !!track
    if (!track) {
      // Nenhum track de áudio: estado silencioso, sem criar AudioContext (evita
      // estourar o limite de ~6 contextos do Chromium).
      setPeaks([0])
      return
    }

    const ctx = new AudioContext({ sampleRate: 48000 })
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
      input.disconnect()
      analyser.disconnect()
      void ctx.close().catch(() => {})
    }
  }, [stream])

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

  // Se não há track de áudio, mostrar estado silencioso em vez de barra vazia
  const hasAudio = hasTrackRef.current && maxPeak > 0

  return (
    <div style={containerStyle}>
      {!hasAudio && (
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: 'var(--panel-2)',
            borderRadius: '5px 5px 0 0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'rgb(138, 147, 170)',
            fontSize: 11,
          }}
        >
          —
        </div>
      )}
      {hasAudio && (
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: 'linear-gradient(to top, var(--accent) 0%, transparent 50%)',
            borderRadius: '5px 5px 0 0',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: `${Math.max(0, barHeight - 2)}px`,
              width: '100%',
            }}
          />
        </div>
      )}
    </div>
  )
}
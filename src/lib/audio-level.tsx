import React, { useState, useRef, useEffect } from 'react'

type AudioLevelProps = {
  stream: MediaStream
  width?: number
  height?: number
  style?: React.CSSProperties
}

export function AudioLevel({ stream, width = 100, height = 50, style }: AudioLevelProps) {
  const [peaks, setPeaks] = useState<number[]>([])
  const ctxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)

  useEffect(() => {
    ctxRef.current = new AudioContext({ sampleRate: 48000 })
    const track = stream.getAudioTracks()[0]
    if (!track) return

    const input = ctxRef.current.createMediaStreamSource(new MediaStream([track]))
    const analyser = ctxRef.current.createAnalyser()
    analyser.fftSize = 256
    analyser.minDecibels = -90
    analyser.maxDecibels = -10
    analyser.smoothingTimeConstant = 0.8
    input.connect(analyser)

    analyserRef.current = analyser

    const dataArray = new Uint8Array(analyser.frequencyBinCount)
    const render = () => {
      analyser.getByteFrequencyData(dataArray)
      const average = dataArray.reduce((a: number, b: number) => a + b, 0) / dataArray.length
      setPeaks(prev => [...prev.slice(-9), average]) // keeps last 10 values
      requestAnimationFrame(render)
    }

    render()

    return () => {
      ctxRef.current?.close()
    }
  }, [stream])

  // Calcular altura máxima baseada nos picos
  const maxPeak = peaks.length > 0 ? Math.max(...peaks) : 0
  const barHeight = (maxPeak / 255) * height // Analyser retorna 0-255

  // Posicionamento fixo: bottom/right do viewport
  const containerStyle: React.CSSProperties = {
    position: 'fixed',
    bottom: 8,
    right: 8,
    zIndex: 1000,
    width: `${width}px`,
    height: `${height}px`,
    ...style,
  }

  return (
    <div style={containerStyle}>
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
        <span
          style={{
            position: 'absolute',
            bottom: 4,
            right: 4,
            color: '#fff',
            fontSize: 12,
          }}
        >
          {maxPeak > 0 ? Math.round(maxPeak) : '—'}
        </span>
      </div>
    </div>
  )
}
// O Windows só deixa capturar o áudio de um aplicativo via WASAPI de "process
// loopback", que entrega PCM cru (Float32 intercalado) por IPC — não uma
// MediaStream. Aqui esses samples viram quadros de AudioData numa
// MediaStreamTrackGenerator, que o WebRTC envia como qualquer outra track.
//
// É o que isola o som: capturando o processo do Chrome, o espectador ouve o vídeo
// compartilhado e não a call do Discord nem o resto do PC.

export type ProcessAudio = {
  stream: MediaStream
  peak: () => number
  dispose: () => void
}

// Se o envio travar, descarta em vez de acumular memória.
const MAX_PENDING = 60

type GeneratorCtor = new (init: { kind: 'audio' }) => MediaStreamTrack & {
  writable: WritableStream<AudioData>
}

export async function startProcessAudio(pid: number): Promise<ProcessAudio | null> {
  const api = window.sinal
  if (!api?.onAudioData || !api.startAudioCapture) return null

  const Generator = (globalThis as unknown as { MediaStreamTrackGenerator?: GeneratorCtor }).MediaStreamTrackGenerator
  if (!Generator || typeof AudioData === 'undefined') return null

  const track = new Generator({ kind: 'audio' })
  const writer = track.writable.getWriter()
  track.contentHint = 'music'

  let peak = 0
  let timestamp = 0
  let pending = 0

  const unsubscribe = api.onAudioData((chunk) => {
    const raw = chunk?.buffer
    if (!raw || !raw.length) return

    const interleaved = raw instanceof Float32Array ? raw : Float32Array.from(raw as ArrayLike<number>)
    const channels = Math.max(1, Math.min(2, Number(chunk.channels) || 1))
    const sampleRate = Number(chunk.sampleRate) || 48000
    const frames = Math.floor(interleaved.length / (Number(chunk.channels) || 1))
    if (!frames) return

    // O AudioData quer os canais em blocos separados (planar), não intercalados.
    const planar = new Float32Array(frames * channels)
    for (let i = 0; i < frames; i += 1) {
      for (let c = 0; c < channels; c += 1) {
        const value = interleaved[i * (Number(chunk.channels) || 1) + (c < (Number(chunk.channels) || 1) ? c : 0)] || 0
        planar[c * frames + i] = value
        const level = Math.abs(value)
        if (level > peak) peak = level
      }
    }

    if (pending >= MAX_PENDING) return
    pending += 1
    const frame = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: frames,
      numberOfChannels: channels,
      timestamp,
      data: planar,
    })
    timestamp += Math.round((frames / sampleRate) * 1e6)
    writer
      .write(frame)
      .catch(() => {})
      .finally(() => {
        pending -= 1
        frame.close()
      })
  })

  const started = await api.startAudioCapture(pid)
  if (!started) {
    unsubscribe()
    void writer.close().catch(() => {})
    return null
  }

  return {
    stream: new MediaStream([track]),
    peak: () => peak,
    dispose: () => {
      unsubscribe()
      void api.stopAudioCapture?.()
      void writer.close().catch(() => {})
      track.stop()
    },
  }
}

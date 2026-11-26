// O loopback do Windows entrega o som do sistema bem baixo quando a saída padrão é
// um dispositivo virtual (o Sonar, por exemplo, roda em 96 kHz e com nível reduzido).
// Como o espectador não escuta quase nada, ele sobe o volume e só ouve o chiado de
// fundo. Aqui o áudio capturado passa por um ganho adaptativo: o nível vai para um
// alvo audível, o silêncio real é fechado (sem ruído) e a track sai marcada como
// música para o encoder gastar banda de verdade.
//
// Isso resolve o som sem pedir para o usuário trocar o dispositivo de saída.
//
// O ganho é a única etapa de nível: testei o DynamicsCompressor do Chromium e ele
// aplica ganho de compensação próprio, então o que saía não obedecia ao alvo (tudo
// acabava em ~ -2,7 dBFS, alto demais no ouvido de quem assiste). Sem ele o nível é
// previsível e, com ataque rápido, um som forte nunca estoura.

export type AudioChain = {
  stream: MediaStream
  peak: () => number
  dispose: () => void
}

const TARGET_PEAK = 0.45 // ~ -7 dBFS: som de jogo audível e confortável
const SILENCE = 0.0008 // ~ -62 dBFS: abaixo disso é ruído de fundo, não som
const MAX_GAIN = 12 // ~ +21 dB: teto para capturas muito baixas

export function boostAudio(source: MediaStream): AudioChain | null {
  const track = source.getAudioTracks()[0]
  if (!track) return null

  const ctx = new AudioContext({ sampleRate: 48000 })
  // A recaptura automática (mudança de formato da janela) não vem de um clique:
  // sem resume o contexto pode nascer suspenso e o áudio sairia mudo.
  void ctx.resume()
  const input = ctx.createMediaStreamSource(new MediaStream([track]))

  const gain = ctx.createGain()
  const destination = ctx.createMediaStreamDestination()
  input.connect(gain)
  gain.connect(destination)

  // O medidor lê o sinal cru (antes do ganho) para saber o quanto ainda falta.
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 2048
  input.connect(analyser)
  const buffer = new Float32Array(analyser.fftSize)

  let peak = 0
  let current = 1
  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(buffer)
    peak = 0
    for (const value of buffer) peak = Math.max(peak, Math.abs(value))

    const target = peak < SILENCE ? 0 : Math.min(MAX_GAIN, TARGET_PEAK / Math.max(peak, 0.0001))
    const now = ctx.currentTime
    gain.gain.cancelScheduledValues(now)
    // Desce na hora (som forte não estoura) e sobe devagar (o volume não bombeia).
    const constant = target < current ? 0.008 : 0.35
    gain.gain.setTargetAtTime(target, now, constant)
    current = current + (target - current) * (constant < 0.05 ? 0.9 : 0.35)
  }, 100)

  const output = destination.stream.getAudioTracks()[0]
  output.contentHint = 'music'

  return {
    stream: new MediaStream([output]),
    peak: () => peak,
    dispose: () => {
      window.clearInterval(timer)
      output.stop()
      track.stop()
      void ctx.close()
    },
  }
}

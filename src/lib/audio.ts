// O loopback do Windows entrega o som do sistema bem baixo quando a saída padrão é
// um dispositivo virtual (o Sonar, por exemplo, roda em 96 kHz e com nível reduzido). Como
// o espectador não escuta quase nada, ele sobe o volume e só ouve o chiado de fundo. Aqui o
// áudio capturado passa por um ganho adaptativo: o nível vai para um alvo audível e a track
// sai marcada como música para o encoder gastar banda de verdade.
//
// Isso resolve o som sem pedir para o usuário trocar o dispositivo de saída.
//
// Duas regras vieram de escutar o resultado:
//
// 1. O ganho NUNCA chega a zero. Fechar o ganho no silêncio ("gate") parecia limpo, mas a
//    captura por processo entrega o som em blocos e às vezes a janela medida não tem sample
//    novo nenhum (não é silêncio, é atraso). A cada janela dessas o ganho caía e voltava,
//    o que o ouvido escuta como som picotando/bombeando. Com o piso em 1 o que não é
//    amplificado passa igual e o silêncio continua silencioso, porque não há sinal.
// 2. O envelope do nível sobe na hora e desce devagar: um bloco atrasado derruba a leitura
//    por ~50 ms, não o volume da música.
export type AudioChain = {
  stream: MediaStream
  peak: () => number
  dispose: () => void
}

const TARGET_PEAK = 0.45 // ~ -7 dBFS: som de jogo audível e confortável
const SILENCE = 0.002 // ~ -54 dBFS: abaixo disso não há o que amplificar
const MAX_GAIN = 12 // ~ +21 dB: teto para capturas muito baixas
const TICK_MS = 50

export function boostAudio(
  source: MediaStream,
  onSwitch?: () => void
): AudioChain | null {
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
  let envelope = 0
  let current = 1
  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(buffer)
    peak = 0
    for (const value of buffer) peak = Math.max(peak, Math.abs(value))

    // Janela sem sinal nenhum: quase sempre é um bloco que ainda não chegou, não uma
    // pausa. Segura o envelope (queda de 2% por leitura) em vez de zerar o ganho.
    envelope = peak > 0 ? Math.max(peak, envelope * 0.9) : envelope * 0.98

    let target =
      envelope < SILENCE ? 1 : Math.min(MAX_GAIN, TARGET_PEAK / Math.max(envelope, 0.0001))
    if (target < 1) target = 1

    // Sobe devagar (o volume não bombeia) e desce rápido o bastante para um pico não
    // estourar, sem nunca passar pelo zero.
    const smoothing = target < current ? 0.35 : 0.12
    current += (target - current) * smoothing

    const now = ctx.currentTime
    gain.gain.cancelScheduledValues(now)
    gain.gain.setTargetAtTime(current, now, 0.03)
  }, TICK_MS)

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
      onSwitch?.()
    },
  }
}

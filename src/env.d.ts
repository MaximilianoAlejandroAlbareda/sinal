/// <reference types="vite/client" />

export type CaptureSource = {
  id: string
  name: string
  thumbnail: string
}

export type AudioProcess = {
  pid: number
  name: string
}

export type AudioChunk = {
  buffer: Float32Array | number[]
  channels: number
  sampleRate: number
}

declare global {
  interface Window {
    sinal?: {
      isDesktop: true
      listSources: () => Promise<CaptureSource[]>
      selectSource: (id: string, audio: boolean) => Promise<void>
      clearSource: () => Promise<void>
      lanInfo: () => Promise<{ port: number; addresses: string[] }>
      listAudioProcesses: () => Promise<AudioProcess[]>
      /** Pid da sessão de áudio dona da janela capturada (desktop, Windows). */
      resolveAudioForSource: (sourceId: string) => Promise<number | null>
      startAudioCapture: (pid: number) => Promise<boolean>
      stopAudioCapture: () => Promise<boolean>
      onAudioData: (callback: (chunk: AudioChunk) => void) => () => void
      onRefit: (callback: () => void) => () => void
    }
  }
}

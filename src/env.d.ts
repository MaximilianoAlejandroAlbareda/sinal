/// <reference types="vite/client" />

export type CaptureSource = {
  id: string
  name: string
  thumbnail: string
}

declare global {
  interface Window {
    sinal?: {
      isDesktop: true
      listSources: () => Promise<CaptureSource[]>
      selectSource: (id: string, audio: boolean) => Promise<void>
      clearSource: () => Promise<void>
      lanInfo: () => Promise<{ port: number; addresses: string[] }>
      onRefit: (callback: () => void) => () => void
    }
  }
}

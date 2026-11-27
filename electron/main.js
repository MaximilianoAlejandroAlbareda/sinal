'use strict'

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow, Menu, dialog, desktopCapturer, ipcMain, session } = require('electron')
const { startServer } = require('../server/signaling')
const { audioPidForSource, warmWindowMap } = require('./window-pids')

const requestedPort = Number(process.env.PORT)
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 8787
// O servidor escuta em todas as interfaces para que o link da sala funcione na rede
// local; a janela do app continua abrindo pelo loopback.
const HOST = '0.0.0.0'
const LOCAL = '127.0.0.1'
const APP_URL = `http://${LOCAL}:${PORT}/`

/** IPv4 desta máquina na rede local, usado no link que os convidados abrem. */
function lanAddresses() {
  const found = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      found.push(entry.address)
    }
  }
  return found
}

// O loopback clássico ("loopback") captura apenas o dispositivo de saída padrão do
// Windows. Com uma saída virtual (SteelSeries Sonar, Voicemod, NVIDIA) selecionada, a
// captura sai muda e a saída precisa ser trocada na mão para transmitir. O modo por
// processo ("loopbackWithoutChrome", Chromium 138+) captura o áudio dos outros apps
// independente de onde ele está saindo, e deixa de fora o som do próprio app — que era
// justamente o que voltava como retorno, porque o preview local era recapturado.
const LOOPBACK_AUDIO_MODE = process.env.SINAL_LOOPBACK === 'padrao' ? 'loopback' : 'loopbackWithoutChrome'

// Áudio de um aplicativo só (WASAPI process loopback, a mesma técnica que o Discord
// e o OBS usam): captura o processo escolhido e seus filhos, sem o resto do PC. É o
// que evita o espectador ouvir a call do Discord junto com o vídeo compartilhado.
// O addon é carregado tarde e de forma tolerante: se ele não carregar, o app segue
// com o áudio de sistema do getDisplayMedia.
let audioCapture = null
let audioCaptureTried = false
let audioDataBound = false

function getAudioCapture() {
  if (audioCaptureTried) return audioCapture
  audioCaptureTried = true
  try {
    audioCapture = require('process-audio-capture').audioCapture
  } catch (err) {
    console.error('Captura de áudio por aplicativo indisponível:', err.message)
    audioCapture = null
  }
  return audioCapture
}

function broadcastAudioData(data) {
  if (!data?.buffer) return
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('audio:data', {
      buffer: data.buffer,
      channels: Number(data.channels) || 1,
      sampleRate: Number(data.sampleRate) || 48000,
    })
  }
}

function bindAudioData(capture) {
  if (audioDataBound) return
  audioDataBound = true
  capture.on('audio-data', broadcastAudioData)
}

let pendingCapture = null

// A proporção da janela compartilhada é vigiada pelo próprio renderer (o preview do
// vídeo avisa quando o frame muda de tamanho, ver refit() em Room.tsx). Aqui não se
// enumera mais a tela a cada 1,5 s: getSources com miniatura trava o processo
// principal por dezenas de ms e é justamente ele que repassa o áudio capturado,
// então cada varredura virava um corte de som de 20-90 ms em quem assiste.

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#0a0b10',
    title: 'Sinal',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.loadURL(APP_URL)
  return win
}

app.whenReady().then(async () => {
  const indexFile = path.join(__dirname, '..', 'dist', 'index.html')
  if (!fs.existsSync(indexFile)) {
    dialog.showErrorBox(
      'Interface não compilada',
      'Rode "bun run build" (ou "bun run app") para compilar a interface antes de abrir o app.',
    )
    app.quit()
    return
  }

  try {
    await startServer({ port: PORT, host: HOST })
  }   catch (err) {
    if (err.code !== 'EADDRINUSE') {
      dialog.showErrorBox('Falha ao abrir a sala', `Não foi possível abrir a porta ${PORT}: ${err.message}`)
      app.quit()
      return
    }
    console.warn(`Porta ${PORT} em uso — reaproveitando o servidor já em execução (pode não aceitar convidados da rede).`)
  }

  for (const address of lanAddresses()) console.log(`Sala acessível na rede em http://${address}:${PORT}/`)

  ipcMain.handle('audio:list', () => {
    const capture = getAudioCapture()
    if (!capture) return []
    try {
      const list = capture.getProcessList() || []
      return list
        .map((item) => ({ pid: item.pid, name: String(item.name || item.description || '').trim() }))
        .filter((item) => item.name.length > 0)
    } catch (err) {
      console.error('Falha ao listar aplicativos com áudio:', err.message)
      return []
    }
  })

  // Qual sessão de áudio pertence à janela escolhida: exato, sem depender do nome.
  ipcMain.handle('audio:resolve', async (_event, sourceId) => {
    const capture = getAudioCapture()
    if (!capture) return null
    try {
      return await audioPidForSource(String(sourceId || ''), capture.getProcessList() || [])
    } catch (err) {
      console.error('Falha ao identificar o áudio da janela:', err.message)
      return null
    }
  })

  ipcMain.handle('audio:start', (_event, pid) => {
    const capture = getAudioCapture()
    if (!capture) return false
    try {
      bindAudioData(capture)
      if (capture.isCapturing) capture.stopCapture()
      return Boolean(capture.startCapture(Number(pid)))
    } catch (err) {
      console.error('Falha ao capturar o áudio do aplicativo:', err.message)
      return false
    }
  })

  ipcMain.handle('audio:stop', () => {
    const capture = getAudioCapture()
    if (!capture) return false
    try {
      return Boolean(capture.stopCapture())
    } catch {
      return false
    }
  })

  // Tela/ventana escolhida no app + áudio do sistema (loopback) no Windows.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      const choice = pendingCapture
      pendingCapture = null
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
        const source = sources.find((item) => item.id === choice?.id) || sources[0]
        if (!source) {
          callback({})
          return
        }
        if (choice?.audio) callback({ video: source, audio: LOOPBACK_AUDIO_MODE })
        else callback({ video: source })
      } catch (err) {
        console.error('Falha ao capturar a tela:', err)
        callback({})
      }
    },
    { useSystemPicker: false },
  )

  ipcMain.handle('capture:list', async () => {
    // Aquece o mapa janela -> processo enquanto o seletor está aberto: quando a
    // pessoa escolhe a janela, o áudio do app já pode ser identificado na hora.
    warmWindowMap()
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false,
    })
    return sources
      .filter((source) => source.name)
      .map((source) => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail?.isEmpty() ? '' : source.thumbnail.toDataURL(),
      }))
  })

  ipcMain.handle('capture:select', (_event, payload) => {
    const id = String(payload?.id || '')
    pendingCapture = { id, audio: Boolean(payload?.audio) }
  })

  ipcMain.handle('capture:clear', () => {
    pendingCapture = null
  })

  ipcMain.handle('app:lan', () => ({ port: PORT, addresses: lanAddresses() }))

  Menu.setApplicationMenu(null)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

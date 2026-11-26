'use strict'

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow, Menu, dialog, desktopCapturer, ipcMain, session } = require('electron')
const { startServer } = require('../server/signaling')

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

let pendingCapture = null

// O Chromium recorta o frame para a proporção escolhida quando a captura começa,
// então se a janela compartilhada muda de formato (ex.: vídeo em tela cheia) a
// imagem sai cortada. Vigiando a proporção real da fonte da para recapturar na hora.
let watched = null

async function computeAspect(id) {
  if (!id) return null
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 180, height: 180 },
    fetchWindowIcons: false,
  })
  const source = sources.find((item) => item.id === id)
  if (!source) return null
  const size = source.thumbnail.getSize()
  if (!size.width || !size.height) return null
  return size.width / size.height
}

function startWatching(id, win) {
  stopWatching()
  watched = { id, aspect: null, timer: null }

  const tick = async () => {
    const current = watched
    if (!current || current.id !== id) return
    try {
      const aspect = await computeAspect(id)
      if (!aspect || !watched || watched.id !== id) return
      if (watched.aspect === null) {
        watched.aspect = aspect
      } else if (Math.abs(aspect - watched.aspect) / watched.aspect > 0.02) {
        watched.aspect = aspect
        if (!win.isDestroyed()) win.webContents.send('capture:refit')
      }
    } catch {
      /* ignora falhas de enumeração */
    }
  }

  watched.timer = setInterval(tick, 1500)
  void tick()
}

function stopWatching() {
  if (watched?.timer) clearInterval(watched.timer)
  watched = null
}

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
        if (choice?.audio) callback({ video: source, audio: 'loopback' })
        else callback({ video: source })
      } catch (err) {
        console.error('Falha ao capturar a tela:', err)
        callback({})
      }
    },
    { useSystemPicker: false },
  )

  ipcMain.handle('capture:list', async () => {
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

  ipcMain.handle('capture:select', (event, payload) => {
    const id = String(payload?.id || '')
    pendingCapture = { id, audio: Boolean(payload?.audio) }
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && id.startsWith('window:')) startWatching(id, win)
    else stopWatching()
  })

  ipcMain.handle('capture:clear', () => {
    pendingCapture = null
    stopWatching()
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

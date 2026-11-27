'use strict'

const { execFile } = require('node:child_process')

// Descobre de qual processo é uma janela capturada. O id do desktopCapturer é
// "window:<HWND>:0" e o Windows sabe qual processo é dono daquele handle.
//
// Isso existe porque casar pelo nome não funciona: a sessão de áudio do Spotify se
// chama "Spotify" e a janela se chama o nome da faixa; num jogo a janela mostra o
// nome da cena e a sessão de áudio mostra o nome do executável. O pid acerta sempre.
//
// O áudio de navegadores sai de um processo filho (o serviço de áudio), por isso o
// mapa de processos pai também vem junto: o pid da sessão pode não ser o dono da
// janela, mas está na mesma árvore.
const PS_CODE = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class SinalWindows {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  public static List<string> List() {
    var found = new List<string>();
    EnumWindows(delegate (IntPtr hWnd, IntPtr lParam) {
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (pid != 0) found.Add(hWnd.ToInt64().ToString() + "|" + pid.ToString());
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

foreach ($item in [SinalWindows]::List()) { "W|$item" }
Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "P|$($_.ProcessId)|$($_.ParentProcessId)" }
`

const TTL_MS = 4000
const TIMEOUT_MS = 6000

let cache = { at: 0, windows: new Map(), parents: new Map() }
let inFlight = null

function runScript() {
  return new Promise((resolve) => {
    const encoded = Buffer.from(PS_CODE, 'utf16le').toString('base64')
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        const windows = new Map()
        const parents = new Map()
        for (const raw of String(stdout).split(/\r?\n/)) {
          const line = raw.trim()
          if (!line) continue
          const parts = line.split('|')
          if (parts.length !== 3) continue
          const first = Number(parts[1])
          const second = Number(parts[2])
          if (!Number.isFinite(first) || !Number.isFinite(second)) continue
          if (parts[0] === 'W') windows.set(first, second)
          else if (parts[0] === 'P') parents.set(first, second)
        }
        resolve(windows.size ? { windows, parents } : null)
      },
    )
  })
}

function windowMap() {
  if (Date.now() - cache.at < TTL_MS) return Promise.resolve(cache)
  if (inFlight) return inFlight
  inFlight = runScript().then((result) => {
    if (result) cache = { at: Date.now(), windows: result.windows, parents: result.parents }
    inFlight = null
    return cache
  })
  return inFlight
}

/** Aquece o mapa sem bloquear (chamado quando o seletor de tela abre). */
function warmWindowMap() {
  if (process.platform !== 'win32') return
  void windowMap()
}

function windowHandle(sourceId) {
  const match = /^window:(-?\d+):/.exec(String(sourceId || ''))
  return match ? Number(match[1]) : null
}

/**
 * Pid da sessão de áudio que pertence à janela capturada, ou null.
 * `apps` é a lista de getProcessList(): [{ pid, name }].
 */
async function audioPidForSource(sourceId, apps) {
  if (process.platform !== 'win32') return null
  const hwnd = windowHandle(sourceId)
  if (hwnd === null) return null

  const list = Array.isArray(apps) ? apps : []
  if (list.length === 0) return null

  const { windows, parents } = await windowMap()
  const owner = windows.get(hwnd)
  if (!owner) return null

  for (const app of list) {
    const sessionPid = Number(app && app.pid)
    if (!Number.isFinite(sessionPid) || sessionPid <= 0) continue
    let pid = sessionPid
    for (let depth = 0; depth < 12 && pid; depth += 1) {
      if (pid === owner) return sessionPid
      pid = parents.get(pid)
    }
  }
  return null
}

module.exports = { audioPidForSource, warmWindowMap }

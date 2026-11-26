import { useState } from 'react'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function randomCode() {
  let code = ''
  for (let index = 0; index < 4; index += 1) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  }
  return code
}

function extractCode(value: string) {
  const fromLink = value.match(/sala\/([A-Za-z0-9]{4,8})/i)
  const raw = (fromLink ? fromLink[1] : value.trim()).toUpperCase().replace(/[^A-Z0-9]/g, '')
  return raw.slice(0, 8)
}

export function Logo() {
  return (
    <span className="logo">
      <span className="logo-mark" aria-hidden="true">
        <span />
      </span>
      <span className="logo-text">
        SINAL
      </span>
    </span>
  )
}

export default function Home() {
  const [name, setName] = useState(() => localStorage.getItem('sinal:nome') ?? '')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')

  function remember(value: string) {
    const clean = value.trim().slice(0, 24)
    if (!clean) {
      setError('Digite seu nome para começar.')
      return null
    }
    localStorage.setItem('sinal:nome', clean)
    setError('')
    return clean
  }

  function createRoom() {
    if (!remember(name)) return
    location.hash = `#/sala/${randomCode()}?host=1`
  }

  function joinRoom() {
    if (!remember(name)) return
    const parsed = extractCode(code)
    if (parsed.length < 4) {
      setError('Informe o código da sala ou cole o link recebido.')
      return
    }
    location.hash = `#/sala/${parsed}`
  }

  return (
    <div className="home">
      <div className="home-glow" aria-hidden="true" />
      <div className="home-inner">
        <Logo />

        <h1 className="home-title">
          Compartilhe sua tela.
          <br />
          <span>Jogue junto.</span>
        </h1>
        <p className="home-subtitle">
          Abra uma sala, mande o link e transmita seu jogo ou sua tela com chat ao vivo. Baixa latência,
          áudio do sistema e até cinco pessoas assistindo.
        </p>

        <div className="card">
          <label className="field">
            <span>Seu nome</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="como os outros vão te ver"
              maxLength={24}
              autoFocus
            />
          </label>

          <button className="button primary large" onClick={createRoom}>
            Criar uma sala
          </button>

          <div className="divider">
            <span>ou entre em uma sala</span>
          </div>

          <div className="join-row">
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') joinRoom()
              }}
              placeholder="Código ou link da sala"
              className="code-input"
            />
            <button className="button" onClick={joinRoom}>
              Entrar
            </button>
          </div>

          {error && <p className="field-error">{error}</p>}
        </div>

        <ul className="features">
          <li>
            <strong>P2P</strong> direto entre os navegadores
          </li>
          <li>
            <strong>Áudio do sistema</strong> no app desktop
          </li>
          <li>
            <strong>Chat</strong> e lista de quem está assistindo
          </li>
        </ul>
      </div>
    </div>
  )
}

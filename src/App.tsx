import { useEffect, useState } from 'react'
import Home from './pages/Home'
import Room from './pages/Room'

type Route = { name: 'home' } | { name: 'room'; code: string; host: boolean }

export function parseHash(hash: string): Route {
  const match = hash.match(/^#\/sala\/([A-Za-z0-9]{4,8})(?:\?(.*))?$/)
  if (!match) return { name: 'home' }
  return {
    name: 'room',
    code: match[1].toUpperCase(),
    host: /(?:^|&)host=1(?:&|$)/.test(match[2] ?? ''),
  }
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash))

  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  if (route.name === 'room') {
    return <Room key={route.code} code={route.code} isHost={route.host} />
  }
  return <Home />
}

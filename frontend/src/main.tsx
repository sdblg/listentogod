import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import Host from './pages/Host'
import Browse from './pages/Browse'

function App() {
  return (
    <div className="container">
      <header>
        <h1>ListenToGod</h1>
        <nav>
          <Link to="/host">Host</Link>
                    <Link to="/browse">Browse</Link>
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<Home/>} />
        <Route path="/host" element={<Host/>} />
          <Route path="/browse" element={<Browse/>} />
      </Routes>
    </div>
  )
}

function Home(){
  return (
    <div>
      <p>Select your role above: Host (speaker) or Browse active rooms.</p>
    </div>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(
  <BrowserRouter>
    <App/>
  </BrowserRouter>
)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').then(() => {
      const pingServiceWorker = () => {
        navigator.serviceWorker.controller?.postMessage({ type: 'KEEP_ALIVE' })
      }

      if (!navigator.serviceWorker.controller) {
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          window.location.reload()
        }, { once: true })
      }

      window.setInterval(pingServiceWorker, 25_000)
      document.addEventListener('visibilitychange', pingServiceWorker)
      pingServiceWorker()
    }).catch((error) => {
      console.warn('Service worker registration failed', error)
    })
  })
}

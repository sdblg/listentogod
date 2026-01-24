import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import Host from './pages/Host'
import Listener from './pages/Listener'

function App() {
  return (
    <div className="container">
      <header>
        <h1>ListenToGod</h1>
        <nav>
          <Link to="/host">Host</Link>
          <Link to="/listen">Listener</Link>
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<Home/>} />
        <Route path="/host" element={<Host/>} />
        <Route path="/listen" element={<Listener/>} />
      </Routes>
    </div>
  )
}

function Home(){
  return (
    <div>
      <p>Select your role above: Host (speaker) or Listener.</p>
    </div>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(
  <BrowserRouter>
    <App/>
  </BrowserRouter>
)

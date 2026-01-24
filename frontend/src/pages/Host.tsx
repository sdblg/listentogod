import React, { useEffect, useRef, useState } from 'react'
import { connectSignaling, getMicStream, makePeerConnection, SignalingMessage } from '../signaling'
import { QRCodeSVG } from 'qrcode.react'

export default function Host(){
  const rooms = [
    { name: 'Chinese Language Room (中文房间)', flag: '🇨🇳' },
    { name: 'Mongolian Language Room (Монгол хэлний өрөө)', flag: '🇲🇳' }
  ]
  const [room, setRoom] = useState(rooms[0].name)
  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState('')
  const [listenerCount, setListenerCount] = useState(0)
  const [listenerUrl, setListenerUrl] = useState('')
  const [micLevel, setMicLevel] = useState(0)
  const wsRef = useRef<WebSocket | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const lastErrorRef = useRef(false)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const dataArrayRef = useRef<Uint8Array | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(()=>{
    return ()=>{
      wsRef.current?.close()
      peersRef.current.forEach(pc=>pc.close())
      localStreamRef.current?.getTracks().forEach(t=>t.stop())
      stopMeter()
    }
  },[])

  async function startHosting(){
    try {
      setStatus('Getting microphone...')
      const mic = await getMicStream()
      localStreamRef.current = mic
      startMeter(mic)
      
      // Generate listener URL with local network IP
      const protocol = window.location.protocol
      const hostname = window.location.hostname === 'localhost' ? getLocalIP() : window.location.hostname
      const port = window.location.port ? `:${window.location.port}` : ''
      const url = `${protocol}//${hostname}${port}/listen?room=${encodeURIComponent(room)}`
      console.log('Generated listener URL:', url)
      setListenerUrl(url)
      
      setStatus('Connecting signaling...')
      const ws = connectSignaling({room, role: 'host'})
      wsRef.current = ws
      ws.onopen = ()=>{ setConnected(true); setStatus('Broadcasting...') }
      ws.onclose = ()=>{
        setConnected(false)
        if (lastErrorRef.current) {
          lastErrorRef.current = false
          return
        }
        setStatus('Disconnected')
      }
      ws.onmessage = async (ev)=>{
        const msg: SignalingMessage = JSON.parse(ev.data)
        if (msg.type === 'error') {
          lastErrorRef.current = true
          setStatus(`Error: ${msg.payload || 'Unknown error'}`)
          ws.close()
          return
        }
        if (msg.type === 'listener-joined' && msg.from){
          const listenerId = msg.from
          setListenerCount(c => c + 1)
          await createOfferForListener(listenerId)
        } else if (msg.type === 'answer' && msg.from){
          const pc = peersRef.current.get(msg.from)
          if (pc && msg.payload){
            await pc.setRemoteDescription(new RTCSessionDescription(msg.payload))
          }
        } else if (msg.type === 'ice' && msg.from && msg.payload){
          const pc = peersRef.current.get(msg.from)
          if (pc){
            try { await pc.addIceCandidate(new RTCIceCandidate(msg.payload)) } catch(e){ console.warn(e) }
          }
        } else if (msg.type === 'listener-left' && msg.from){
          const pc = peersRef.current.get(msg.from)
          if (pc){ pc.close(); peersRef.current.delete(msg.from) }
          setListenerCount(c => Math.max(0, c - 1))
        }
      }
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  async function createOfferForListener(listenerId: string){
    const pc = makePeerConnection()
    peersRef.current.set(listenerId, pc)

    const stream = localStreamRef.current!
    for (const track of stream.getTracks()){
      const sender = pc.addTrack(track, stream)
      const params = sender.getParameters()
      params.encodings = params.encodings || [{}]
      params.encodings[0].maxBitrate = 64000 // target ~64kbps
      params.encodings[0].dtx = true
      params.encodings[0].ptime = 20
      sender.setParameters(params).catch(()=>{})
    }

    pc.onicecandidate = (ev)=>{
      if (ev.candidate){
        wsRef.current?.send(JSON.stringify({ type: 'ice', to: listenerId, payload: ev.candidate }))
      }
    }

    const offer = await pc.createOffer({ offerToReceiveAudio: false })
    await pc.setLocalDescription(offer)
    wsRef.current?.send(JSON.stringify({ type: 'offer', payload: offer }))
  }

  function stopHosting(){
    wsRef.current?.close()
    peersRef.current.forEach(pc => pc.close())
    peersRef.current.clear()
    localStreamRef.current?.getTracks().forEach(t => t.stop())
    localStreamRef.current = null
    stopMeter()
    setConnected(false)
    setListenerCount(0)
    setListenerUrl('')
    setStatus('Broadcast stopped')
  }

  function startMeter(stream: MediaStream){
    stopMeter()
    const ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    const dataArray = new Uint8Array(analyser.frequencyBinCount)

    source.connect(analyser)
    audioCtxRef.current = ctx
    analyserRef.current = analyser
    dataArrayRef.current = dataArray

    const tick = ()=>{
      const a = analyserRef.current
      const d = dataArrayRef.current
      if (!a || !d) return
      a.getByteTimeDomainData(d)
      let sum = 0
      for (let i = 0; i < d.length; i++) {
        const v = (d[i] - 128) / 128 // normalize -1..1
        sum += v * v
      }
      const rms = Math.sqrt(sum / d.length)
      const level = Math.min(100, Math.round(rms * 140)) // simple scaling
      setMicLevel(level)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  function stopMeter(){
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    analyserRef.current = null
    dataArrayRef.current = null
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(()=>{})
      audioCtxRef.current = null
    }
    setMicLevel(0)
  }

  function getLocalIP() {
    // Fallback to showing window.location.hostname
    // In production, you might want to display the actual IP from the network
    return window.location.hostname
  }

  return (
    <div>
      <h2>Host (Speaker)</h2>
      <p>Broadcast your audio to many listeners over Wi-Fi.</p>
      <div style={{display:'flex', gap:16, alignItems:'center', flexWrap:'wrap'}}>
        <div style={{display:'flex', gap:12}}>
          {rooms.map(r => (
            <label key={r.name} style={{display:'flex', alignItems:'center', gap:6, opacity: connected ? 0.6 : 1}}>
              <input
                type="checkbox"
                checked={room === r.name}
                onChange={()=>setRoom(r.name)}
                disabled={connected}
              />
              <span style={{fontSize:'1.1em'}}>{r.flag}</span>
              {r.name}
            </label>
          ))}
        </div>
        {!connected ? (
          <button onClick={startHosting}>Start Broadcasting</button>
        ) : (
          <button onClick={stopHosting} style={{backgroundColor:'#dc3545', color:'white'}}>Stop Broadcasting</button>
        )}
      </div>
      <p><strong>Status:</strong> {status}</p>
      <p><strong>Listeners:</strong> <span style={{fontSize:'1.5em', fontWeight:'bold'}}>{listenerCount}</span></p>
      {connected && (
        <div style={{marginTop:8}}>
          <div style={{fontWeight:'bold'}}>Mic level:</div>
          <div style={{height:10, background:'#eee', borderRadius:4, overflow:'hidden', width:200}}>
            <div style={{height:'100%', width:`${micLevel}%`, background:'#28a745', transition:'width 80ms linear'}}></div>
          </div>
          <span style={{fontSize:'0.9em'}}>{micLevel}%</span>
        </div>
      )}
      
      {connected && (
        <div style={{marginTop:24, padding:16, border:'2px solid #ddd', borderRadius:8, backgroundColor:'#f9f9f9'}}>
          <h3>Scan to Join as Listener</h3>
          {listenerUrl ? (
            <div style={{display:'flex', flexDirection:'column', alignItems:'center', gap:12}}>
              <QRCodeSVG value={listenerUrl} size={200} level="M" />
              <p style={{fontSize:'0.9em', wordBreak:'break-all', maxWidth:300, textAlign:'center'}}>
                {listenerUrl}
              </p>
            </div>
          ) : (
            <p>Generating QR code...</p>
          )}
        </div>
      )}
    </div>
  )
}

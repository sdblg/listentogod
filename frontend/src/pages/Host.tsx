import React, { useEffect, useRef, useState } from 'react'
import { connectSignaling, getMicStream, makePeerConnection, SignalingMessage } from '../signaling'
import { QRCodeSVG } from 'qrcode.react'

export default function Host(){
  const [room, setRoom] = useState('demo')
  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState('')
  const [listenerCount, setListenerCount] = useState(0)
  const [listenerUrl, setListenerUrl] = useState('')
  const wsRef = useRef<WebSocket | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map())

  useEffect(()=>{
    return ()=>{
      wsRef.current?.close()
      peersRef.current.forEach(pc=>pc.close())
      localStreamRef.current?.getTracks().forEach(t=>t.stop())
    }
  },[])

  async function startHosting(){
    try {
      setStatus('Getting microphone...')
      const mic = await getMicStream()
      localStreamRef.current = mic
      
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
      ws.onclose = ()=>{ setConnected(false); setStatus('Disconnected') }
      ws.onmessage = async (ev)=>{
        const msg: SignalingMessage = JSON.parse(ev.data)
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
      pc.addTrack(track, stream)
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
    setConnected(false)
    setListenerCount(0)
    setListenerUrl('')
    setStatus('Broadcast stopped')
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
      <div style={{display:'flex', gap:8, alignItems:'center', flexWrap:'wrap'}}>
        <input value={room} onChange={e=>setRoom(e.target.value)} placeholder="room name" disabled={connected} />
        {!connected ? (
          <button onClick={startHosting}>Start Broadcasting</button>
        ) : (
          <button onClick={stopHosting} style={{backgroundColor:'#dc3545', color:'white'}}>Stop Broadcasting</button>
        )}
      </div>
      <p><strong>Status:</strong> {status}</p>
      <p><strong>Listeners:</strong> <span style={{fontSize:'1.5em', fontWeight:'bold'}}>{listenerCount}</span></p>
      
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

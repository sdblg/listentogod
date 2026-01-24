import React, { useEffect, useRef, useState } from 'react'
import { connectSignaling, makePeerConnection, SignalingMessage } from '../signaling'

export default function Listener(){
  const params = new URLSearchParams(window.location.search)
  const [room, setRoom] = useState(params.get('room') || 'demo')
  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState('')
  const wsRef = useRef<WebSocket | null>(null)
  const audioOutRef = useRef<HTMLAudioElement | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const hostIdRef = useRef<string>('')

  useEffect(()=>{
    return ()=>{ wsRef.current?.close(); pcRef.current?.close() }
  },[])

  function startListening(){
    setStatus('Connecting signaling...')
    const ws = connectSignaling({room, role: 'listener'})
    wsRef.current = ws
    ws.onopen = ()=>{ setConnected(true); setStatus('Connected to room...') }
    ws.onclose = ()=>{ setConnected(false); setStatus('Disconnected') }
    ws.onmessage = async (ev)=>{
      const msg: SignalingMessage = JSON.parse(ev.data)
      if (msg.type === 'offer' && msg.from && msg.payload){
        hostIdRef.current = msg.from
        const pc = pcRef.current ?? makePeerConnection()
        pcRef.current = pc
        pc.onicecandidate = (ev)=>{
          if (ev.candidate){
            wsRef.current?.send(JSON.stringify({ type: 'ice', to: hostIdRef.current, payload: ev.candidate }))
          }
        }
        pc.ontrack = (ev)=>{
          const [stream] = ev.streams
          if (audioOutRef.current){
            audioOutRef.current.srcObject = stream
            audioOutRef.current.play().catch(()=>{})
          }
        }
        await pc.setRemoteDescription(new RTCSessionDescription(msg.payload))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        wsRef.current?.send(JSON.stringify({ type: 'answer', to: hostIdRef.current, payload: answer }))
        setStatus('Receiving audio...')
      } else if (msg.type === 'ice' && msg.from && msg.payload){
        const pc = pcRef.current
        if (pc){
          try { await pc.addIceCandidate(new RTCIceCandidate(msg.payload)) } catch(e){ console.warn(e) }
        }
      } else if (msg.type === 'host-left'){
        setStatus('Host left the room')
        pcRef.current?.close(); pcRef.current = null
      } else if (msg.type === 'host-ready'){
        setStatus('Host is ready, waiting for offer...')
      }
    }
  }

  return (
    <div>
      <h2>Listener</h2>
      <p>Join a room to listen to the host's audio.</p>
      <div style={{display:'flex', gap:8, alignItems:'center', flexWrap:'wrap'}}>
        <input value={room} onChange={e=>setRoom(e.target.value)} placeholder="room name" disabled={connected} />
        <button onClick={startListening} disabled={connected}>Join Room</button>
      </div>
      <p><strong>Status:</strong> {status}</p>
      <details>
        <summary>Audio Output</summary>
        <audio ref={audioOutRef} controls style={{width:'100%'}}></audio>
      </details>
    </div>
  )
}

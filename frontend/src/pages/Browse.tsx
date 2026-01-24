import React, { useEffect, useRef, useState } from 'react'
import { connectSignaling, makePeerConnection, SignalingMessage } from '../signaling'

type RoomInfo = {
  name: string
  description?: string
  flag?: string
  joinLabel?: string
}

export default function Browse(){
  const [rooms] = useState<RoomInfo[]>([
    { name: 'Chinese Language Room (中文房间)', description: 'Speak & listen in Chinese', flag: '🇨🇳', joinLabel: '加入' },
    { name: 'Mongolian Language Room (Монгол хэлний өрөө)', description: 'Speak & listen in Mongolian', flag: '🇲🇳', joinLabel: 'Нэгдэх' }
  ])
  const [error, setError] = useState('')
  const [joinedRoom, setJoinedRoom] = useState('')
  const [listenStatus, setListenStatus] = useState('')
  const [listening, setListening] = useState(false)
  const [audioLevel, setAudioLevel] = useState(0)

  const wsRef = useRef<WebSocket | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const audioOutRef = useRef<HTMLAudioElement | null>(null)
  const hostIdRef = useRef<string>('')
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const dataArrayRef = useRef<Uint8Array | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    // No polling needed; static curated room list
    return () => {
      stopListening()
    }
  }, [])

  function joinRoom(roomName: string){
    stopListening()
    setJoinedRoom(roomName)
    setListenStatus('Connecting...')

    const ws = connectSignaling({room: roomName, role: 'listener'})
    wsRef.current = ws
    ws.onopen = ()=>{ setListening(true); setListenStatus('Connected, waiting for audio...') }
    ws.onclose = ()=>{ setListening(false); setListenStatus('Disconnected') }
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
          startMeter(stream)
        }
        await pc.setRemoteDescription(new RTCSessionDescription(msg.payload))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        wsRef.current?.send(JSON.stringify({ type: 'answer', to: hostIdRef.current, payload: answer }))
        setListenStatus('Receiving audio...')
      } else if (msg.type === 'ice' && msg.from && msg.payload){
        const pc = pcRef.current
        if (pc){
          try { await pc.addIceCandidate(new RTCIceCandidate(msg.payload)) } catch(e){ console.warn(e) }
        }
      } else if (msg.type === 'host-left'){
        setListenStatus('Host left the room')
        stopListening()
      }
    }
  }

  function stopListening(){
    wsRef.current?.close()
    wsRef.current = null
    pcRef.current?.close()
    pcRef.current = null
    stopMeter()
    hostIdRef.current = ''
    if (audioOutRef.current){
      audioOutRef.current.srcObject = null
    }
    setListening(false)
    setListenStatus('')
    setJoinedRoom('')
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
        const v = (d[i] - 128) / 128
        sum += v * v
      }
      const rms = Math.sqrt(sum / d.length)
      const level = Math.min(100, Math.round(rms * 140))
      setAudioLevel(level)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  function stopMeter(){
    if (rafRef.current !== null){
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    analyserRef.current = null
    dataArrayRef.current = null
    if (audioCtxRef.current){
      audioCtxRef.current.close().catch(()=>{})
      audioCtxRef.current = null
    }
    setAudioLevel(0)
  }

  return (
    <div>
      <h2>Available Rooms</h2>
      <p>Select the curated room below and click Join.</p>

      {error && <p style={{color:'red'}}>{error}</p>}

      <div style={{marginTop:20, border:'1px solid #eee', borderRadius:8, padding:12}}>
        {rooms.map((room) => (
          <div key={room.name} style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:12}}>
            <div>
              <div style={{fontWeight:'bold', display:'flex', alignItems:'center', gap:6}}>
                {room.flag && <span style={{fontSize:'1.2em'}}>{room.flag}</span>}
                {room.name}
              </div>
              {room.description && <div style={{color:'#666', fontSize:'0.9em'}}>{room.description}</div>}
            </div>
            <button onClick={() => joinRoom(room.name)} style={{
              backgroundColor: '#28a745',
              color: 'white',
              border: 'none',
              padding: '6px 12px',
              borderRadius: '4px',
              cursor: 'pointer'
            }}>
              {room.joinLabel || 'Join'}
            </button>
          </div>
        ))}
      </div>

      <div style={{marginTop:24, padding:12, border:'1px solid #eee', borderRadius:8}}>
        <h3>Current Room</h3>
        {joinedRoom ? (
          <>
            <p><strong>Room:</strong> {joinedRoom}</p>
            <p><strong>Status:</strong> {listenStatus || 'Connecting...'}</p>
            <audio ref={audioOutRef} autoPlay controls style={{width:'100%'}} />
            {listening && (
              <div style={{marginTop:8}}>
                <div style={{fontWeight:'bold'}}>Audio level:</div>
                <div style={{height:10, background:'#eee', borderRadius:4, overflow:'hidden', width:200}}>
                  <div style={{height:'100%', width:`${audioLevel}%`, background:'#28a745', transition:'width 80ms linear'}}></div>
                </div>
                <span style={{fontSize:'0.9em'}}>{audioLevel}%</span>
              </div>
            )}
            <div style={{marginTop:8}}>
              <button onClick={stopListening} disabled={!listening} style={{
                backgroundColor: '#dc3545', color: 'white', border: 'none', padding: '6px 12px', borderRadius: 4, cursor: 'pointer'
              }}>Stop Listening</button>
            </div>
          </>
        ) : (
          <p style={{color:'#666'}}>Select a room and press Join to start listening.</p>
        )}
      </div>
    </div>
  )
}

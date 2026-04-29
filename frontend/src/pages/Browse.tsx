import React, { useEffect, useRef, useState } from 'react'
import {
  clearMediaSession,
  releaseWakeLock,
  requestWakeLock,
  startBackgroundSession,
  stopBackgroundSession,
  updateMediaSession
} from '../backgroundSession'
import { makePeerConnection, RobustSignalingClient, SignalingMessage } from '../signaling'

type RoomInfo = {
  name: string
  description?: string
  flag?: string
  joinLabel?: string
}

type CapabilityState = {
  secureContext: boolean
  standalone: boolean
  mediaSession: boolean
  wakeLock: boolean
  serviceWorkerControlled: boolean
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
  const [capabilityState, setCapabilityState] = useState<CapabilityState>({
    secureContext: window.isSecureContext,
    standalone: window.matchMedia('(display-mode: standalone)').matches,
    mediaSession: 'mediaSession' in navigator,
    wakeLock: 'wakeLock' in navigator,
    serviceWorkerControlled: !!navigator.serviceWorker?.controller
  })

  const signalingRef = useRef<RobustSignalingClient | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const audioOutRef = useRef<HTMLAudioElement | null>(null)
  const hostIdRef = useRef<string>('')
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const dataArrayRef = useRef<Uint8Array | null>(null)
  const rafRef = useRef<number | null>(null)
  const playbackWatchdogRef = useRef<number | null>(null)

  useEffect(() => {
    // No polling needed; static curated room list
    return () => {
      stopListening()
    }
  }, [])

  useEffect(() => {
    const syncCapabilities = () => {
      setCapabilityState({
        secureContext: window.isSecureContext,
        standalone: window.matchMedia('(display-mode: standalone)').matches,
        mediaSession: 'mediaSession' in navigator,
        wakeLock: 'wakeLock' in navigator,
        serviceWorkerControlled: !!navigator.serviceWorker?.controller
      })
    }
    syncCapabilities()
    const timer = window.setInterval(syncCapabilities, 5_000)
    window.addEventListener('focus', syncCapabilities)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', syncCapabilities)
    }
  }, [])

  useEffect(() => {
    if (!listening || !audioOutRef.current) {
      if (playbackWatchdogRef.current !== null) {
        window.clearInterval(playbackWatchdogRef.current)
        playbackWatchdogRef.current = null
      }
      return
    }

    playbackWatchdogRef.current = window.setInterval(() => {
      const audio = audioOutRef.current
      if (!audio || !listening) return
      if (audio.paused) {
        audio.play().catch(() => {})
      }
    }, 4_000)

    return () => {
      if (playbackWatchdogRef.current !== null) {
        window.clearInterval(playbackWatchdogRef.current)
        playbackWatchdogRef.current = null
      }
    }
  }, [listening])

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        // Do not suspend socket/audio on lock; keep session anchored.
        startBackgroundSession().catch(() => {})
        return
      }
      resumePlaybackFromMediaSession().catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  async function resumePlaybackFromMediaSession(){
    await startBackgroundSession().catch(() => {})
    const ctx = audioCtxRef.current
    if (ctx && ctx.state === 'suspended') {
      await ctx.resume().catch(() => {})
    }
    await audioOutRef.current?.play().catch(() => {})
    if (signalingRef.current && !signalingRef.current.isConnected()) {
      signalingRef.current.connect()
    }
  }

  async function joinRoom(roomName: string){
    stopListening()
    setError('')
    setJoinedRoom(roomName)
    setListenStatus('Preparing listening session...')

    try {
      await startBackgroundSession()
      await requestWakeLock()
      updateMediaSession({
        title: 'Live Translation',
        artist: 'Listen to God',
        album: 'Church Service',
        artwork512: '/icons/icon-512.svg',
        onPlay: () => { resumePlaybackFromMediaSession().catch(() => {}) },
        onPause: () => { audioOutRef.current?.pause() },
        onStop: () => stopListening()
      })
    } catch (e) {
      setError(`Could not start background audio keep-alive: ${e instanceof Error ? e.message : 'Unknown error'}`)
      stopListening()
      return
    }

    const signaling = new RobustSignalingClient({ room: roomName, role: 'listener', heartbeatIntervalMs: 7_000 })
    signalingRef.current = signaling

    signaling.onOpen(() => {
      setListening(true)
      setListenStatus('Connected, waiting for audio...')
    })
    signaling.onStateChange((state) => {
      if (state === 'reconnecting') {
        setListenStatus('Reconnecting...')
      }
    })
    signaling.onClose(() => {
      setListening(false)
      setListenStatus('Disconnected')
    })
    signaling.onMessage(async (msg: SignalingMessage) => {
      if (msg.type === 'offer' && msg.from && msg.payload){
        hostIdRef.current = msg.from
        if (pcRef.current) {
          pcRef.current.close()
        }
        const pc = makePeerConnection()
        pcRef.current = pc
        pc.onicecandidate = (ev)=>{
          if (ev.candidate){
            signalingRef.current?.send({ type: 'ice', to: hostIdRef.current, payload: ev.candidate })
          }
        }
        pc.ontrack = (ev)=>{
          const [stream] = ev.streams
          if (audioOutRef.current){
            audioOutRef.current.srcObject = stream
            audioOutRef.current.play().catch(()=>{})
            // Switch media focus to live stream element once available.
            stopBackgroundSession()
            updateMediaSession({
              title: 'Live Translation',
              artist: 'Listen to God',
              album: 'Church Service',
              artwork512: '/icons/icon-512.svg',
              onPlay: () => { resumePlaybackFromMediaSession().catch(() => {}) },
              onPause: () => { audioOutRef.current?.pause() },
              onStop: () => stopListening()
            })
          }
          startMeter(stream)
        }
        await pc.setRemoteDescription(new RTCSessionDescription(msg.payload))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        signalingRef.current?.send({ type: 'answer', to: hostIdRef.current, payload: answer })
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
    })
    signaling.connect()
  }

  function stopListening(){
    signalingRef.current?.disconnect()
    signalingRef.current = null
    pcRef.current?.close()
    pcRef.current = null
    stopMeter()
    stopBackgroundSession()
    clearMediaSession()
    releaseWakeLock().catch(() => {})
    hostIdRef.current = ''
    if (audioOutRef.current){
      audioOutRef.current.srcObject = null
      audioOutRef.current.pause()
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
      {!capabilityState.secureContext && (
        <p style={{color:'red'}}>
          This session is not secure. Open using trusted HTTPS on local IP to improve lock-screen playback.
        </p>
      )}
      {!capabilityState.standalone && (
        <p style={{color:'#b36b00'}}>
          Install as PWA (Add to Home Screen) for better background resilience.
        </p>
      )}

      <div style={{marginTop:12, border:'1px solid #e6e6e6', borderRadius:8, padding:10, fontSize:'0.9em', background:'#fafafa'}}>
        <div><strong>Runtime status</strong></div>
        <div>Secure Context: {capabilityState.secureContext ? 'Yes' : 'No'}</div>
        <div>PWA Standalone: {capabilityState.standalone ? 'Yes' : 'No'}</div>
        <div>Media Session API: {capabilityState.mediaSession ? 'Yes' : 'No'}</div>
        <div>Wake Lock API: {capabilityState.wakeLock ? 'Yes' : 'No'}</div>
        <div>Service Worker Active: {capabilityState.serviceWorkerControlled ? 'Yes' : 'No'}</div>
      </div>

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
              {room.joinLabel || 'Start Listening'}
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
            {!listening && (
              <button onClick={() => resumePlaybackFromMediaSession().catch(() => {})} style={{
                marginTop: 8,
                backgroundColor: '#007bff',
                color: 'white',
                border: 'none',
                padding: '6px 12px',
                borderRadius: 4,
                cursor: 'pointer'
              }}>
                Resume Playback
              </button>
            )}
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

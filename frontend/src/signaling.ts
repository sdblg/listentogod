export type SignalingMessage = {
  type: string;
  from?: string;
  to?: string;
  payload?: any;
}

export function connectSignaling({room, role, server}: {room: string; role: 'host'|'listener'; server?: string}) {
  // Determine WebSocket URL based on current page location
  let wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws'
  let wsHost = location.hostname
  let wsPort = location.protocol === 'https:' ? '8443' : '8080'
  
  const url = `${server || wsProtocol + '://' + wsHost + ':' + wsPort}/ws?room=${encodeURIComponent(room)}&role=${role}`
  console.log('Connecting to WebSocket:', url)
  const ws = new WebSocket(url)
  ws.onerror = (error) => {
    console.error('WebSocket error:', error)
  }
  ws.onopen = () => {
    console.log('WebSocket connected successfully')
  }
  ws.onclose = (event) => {
    console.log('WebSocket closed:', event.code, event.reason)
  }
  return ws
}

export async function getMicStream(deviceId?: string): Promise<MediaStream> {
  // Check if mediaDevices is available (requires secure context)
  if (!navigator.mediaDevices) {
    throw new Error(
      'Media devices not available. This app requires HTTPS or localhost. ' +
      'If using an IP address, make sure you\'re accessing via HTTPS.'
    )
  }
  
  if (!navigator.mediaDevices.getUserMedia) {
    throw new Error(
      'getUserMedia is not supported in this browser or secure context.'
    )
  }

  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      sampleRate: 48000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      // Advanced constraints for better voice quality
      latency: 0.01,
    } as MediaTrackConstraints
  })
}

export function makePeerConnection() {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  })
  // Lower latency hint
  // @ts-expect-error non-standard
  pc.sdpSemantics = 'unified-plan'
  return pc
}

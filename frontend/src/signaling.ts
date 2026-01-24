export type SignalingMessage = {
  type: string;
  from?: string;
  to?: string;
  payload?: any;
}

export function connectSignaling({room, role, server}: {room: string; role: 'host'|'listener'; server?: string}) {
  const url = `${server || location.protocol.replace('http','ws') + '//' + location.hostname + ':8080'}/ws?room=${encodeURIComponent(room)}&role=${role}`
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
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      sampleRate: 48000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false
    }
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

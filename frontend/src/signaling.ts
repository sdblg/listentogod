export type SignalingMessage = {
  type: string;
  from?: string;
  to?: string;
  payload?: any;
}

type SignalingRole = 'host' | 'listener'

type SignalingConnectArgs = {
  room: string
  role: SignalingRole
  server?: string
}

type RobustSignalingOptions = SignalingConnectArgs & {
  heartbeatIntervalMs?: number
  heartbeatTimeoutMs?: number | null
  reconnectBaseDelayMs?: number
  reconnectMaxDelayMs?: number
  reconnectJitterMs?: number
}

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed'

const DEFAULT_HEARTBEAT_INTERVAL_MS = 7_000
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000
const DEFAULT_RECONNECT_JITTER_MS = 400

function createSignalingUrl({ room, role, server }: SignalingConnectArgs): string {
  const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws'
  const wsHost = location.hostname
  const wsPort = location.protocol === 'https:' ? '8443' : '8080'
  const base = server || `${wsProtocol}://${wsHost}:${wsPort}`
  return `${base}/ws?room=${encodeURIComponent(room)}&role=${role}`
}

export class RobustSignalingClient {
  private readonly args: SignalingConnectArgs
  private readonly heartbeatIntervalMs: number
  private readonly heartbeatTimeoutMs: number | null
  private readonly reconnectBaseDelayMs: number
  private readonly reconnectMaxDelayMs: number
  private readonly reconnectJitterMs: number

  private ws: WebSocket | null = null
  private manualClose = false
  private heartbeatTimer: number | null = null
  private reconnectTimer: number | null = null
  private reconnectAttempts = 0
  private lastSeenMessageAt = Date.now()
  private state: ConnectionState = 'idle'

  private openHandlers: Array<() => void> = []
  private closeHandlers: Array<(ev: CloseEvent) => void> = []
  private errorHandlers: Array<(ev: Event) => void> = []
  private messageHandlers: Array<(msg: SignalingMessage) => void> = []
  private stateHandlers: Array<(state: ConnectionState) => void> = []

  constructor(options: RobustSignalingOptions) {
    this.args = { room: options.room, role: options.role, server: options.server }
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? null
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS
    this.reconnectJitterMs = options.reconnectJitterMs ?? DEFAULT_RECONNECT_JITTER_MS
  }

  onOpen(handler: () => void): void { this.openHandlers.push(handler) }
  onClose(handler: (ev: CloseEvent) => void): void { this.closeHandlers.push(handler) }
  onError(handler: (ev: Event) => void): void { this.errorHandlers.push(handler) }
  onMessage(handler: (msg: SignalingMessage) => void): void { this.messageHandlers.push(handler) }
  onStateChange(handler: (state: ConnectionState) => void): void { this.stateHandlers.push(handler) }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    this.manualClose = false
    this.updateState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting')
    const url = createSignalingUrl(this.args)
    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      this.reconnectAttempts = 0
      this.lastSeenMessageAt = Date.now()
      this.updateState('connected')
      this.startHeartbeat()
      this.openHandlers.forEach((handler) => handler())
    }

    ws.onerror = (event) => {
      this.errorHandlers.forEach((handler) => handler(event))
    }

    ws.onmessage = (event) => {
      this.lastSeenMessageAt = Date.now()
      const raw = String(event.data)
      let msg: SignalingMessage
      try {
        msg = JSON.parse(raw) as SignalingMessage
      } catch {
        return
      }

      if (msg.type === 'ping') {
        this.send({ type: 'pong', payload: Date.now() })
        return
      }

      if (msg.type === 'pong') {
        return
      }

      this.messageHandlers.forEach((handler) => handler(msg))
    }

    ws.onclose = (event) => {
      this.stopHeartbeat()
      this.closeHandlers.forEach((handler) => handler(event))
      this.ws = null
      if (!this.manualClose) {
        this.scheduleReconnect()
      } else {
        this.updateState('closed')
      }
    }
  }

  send(message: SignalingMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false
    }
    this.ws.send(JSON.stringify(message))
    return true
  }

  disconnect(): void {
    this.manualClose = true
    this.clearReconnectTimer()
    this.stopHeartbeat()
    if (this.ws && this.ws.readyState < WebSocket.CLOSING) {
      this.ws.close()
    }
    this.ws = null
    this.updateState('closed')
  }

  isConnected(): boolean {
    return this.state === 'connected'
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = window.setInterval(() => {
      if (this.heartbeatTimeoutMs !== null) {
        const staleMs = Date.now() - this.lastSeenMessageAt
        if (staleMs > this.heartbeatTimeoutMs) {
          if (this.ws && this.ws.readyState < WebSocket.CLOSING) {
            this.ws.close(4000, 'Heartbeat timeout')
          }
          return
        }
      }

      const sent = this.send({ type: 'ping', payload: Date.now() })
      if (!sent && this.ws && this.ws.readyState < WebSocket.CLOSING) {
        if (this.ws && this.ws.readyState < WebSocket.CLOSING) {
          this.ws.close(4001, 'Heartbeat send failed')
        }
      }
    }, this.heartbeatIntervalMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer()
    this.reconnectAttempts += 1
    const expDelay = this.reconnectBaseDelayMs * 2 ** (this.reconnectAttempts - 1)
    const cappedDelay = Math.min(this.reconnectMaxDelayMs, expDelay)
    const jitter = Math.round(Math.random() * this.reconnectJitterMs)
    const reconnectDelay = cappedDelay + jitter

    this.updateState('reconnecting')
    this.reconnectTimer = window.setTimeout(() => this.connect(), reconnectDelay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private updateState(next: ConnectionState): void {
    this.state = next
    this.stateHandlers.forEach((handler) => handler(next))
  }
}

export function connectSignaling({ room, role, server }: SignalingConnectArgs) {
  const url = createSignalingUrl({ room, role, server })
  return new WebSocket(url)
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

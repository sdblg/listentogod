const SILENT_MP3_DATA_URI =
  'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU2LjM2LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV6urq6urq6urq6urq6urq6urq6urq6urq6v////////////////////////////////8AAAAATGF2YzU2LjQxAAAAAAAAAAAAAAAAJAAAAAAAAAAAASDs90hvAAAAAAAAAAAAAAAAAAAA//MUZAAAAAGkAAAAAAAAA0gAAAAATEFN//MUZAMAAAGkAAAAAAAAA0gAAAAARTMu//MUZAYAAAGkAAAAAAAAA0gAAAAAOTku//MUZAkAAAGkAAAAAAAAA0gAAAAANVVV'

type MediaSessionCopy = {
  title: string
  artist: string
  album?: string
  artwork512?: string
  onPlay?: () => void
  onPause?: () => void
  onStop?: () => void
}

class WakeLockManager {
  private sentinel: WakeLockSentinel | null = null
  private active = false

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.active) {
        this.request().catch(() => {})
      }
    })
  }

  async request(): Promise<boolean> {
    if (!('wakeLock' in navigator)) return false
    try {
      this.active = true
      this.sentinel = await navigator.wakeLock.request('screen')
      this.sentinel.addEventListener('release', () => {
        this.sentinel = null
      })
      return true
    } catch {
      return false
    }
  }

  async release(): Promise<void> {
    this.active = false
    if (this.sentinel) {
      await this.sentinel.release().catch(() => {})
      this.sentinel = null
    }
  }
}

class SilentAudioKeepAlive {
  private audio: HTMLAudioElement | null = null
  private started = false
  private resumeTimer: number | null = null

  async start(): Promise<void> {
    if (this.started) return

    const audio = document.createElement('audio')
    audio.src = SILENT_MP3_DATA_URI
    audio.loop = true
    audio.preload = 'auto'
    audio.playsInline = true
    audio.controls = false
    audio.muted = false
    // Keep non-zero volume to preserve media-player state on some mobile OSes.
    audio.volume = 1
    audio.style.display = 'none'
    document.body.appendChild(audio)

    await audio.play()
    this.audio = audio
    this.started = true
    this.startResumeLoop()
  }

  stop(): void {
    if (!this.audio) return
    this.audio.pause()
    this.audio.removeAttribute('src')
    this.audio.load()
    this.audio.remove()
    this.audio = null
    this.started = false
    this.stopResumeLoop()
  }

  private startResumeLoop(): void {
    this.stopResumeLoop()
    this.resumeTimer = window.setInterval(() => {
      if (!this.audio) return
      if (this.audio.paused) {
        this.audio.play().catch(() => {})
      }
    }, 4_000)
  }

  private stopResumeLoop(): void {
    if (this.resumeTimer !== null) {
      window.clearInterval(this.resumeTimer)
      this.resumeTimer = null
    }
  }
}

const wakeLockManager = new WakeLockManager()
const silentAudioKeepAlive = new SilentAudioKeepAlive()
const DEFAULT_ARTWORK_512 = '/icons/icon-512.svg'
let visibilityAttached = false

export async function startBackgroundSession(): Promise<void> {
  await silentAudioKeepAlive.start()
  attachVisibilityKeepAlive()
}

export function stopBackgroundSession(): void {
  silentAudioKeepAlive.stop()
}

export async function requestWakeLock(): Promise<boolean> {
  return wakeLockManager.request()
}

export async function releaseWakeLock(): Promise<void> {
  await wakeLockManager.release()
}

export function updateMediaSession(copy: MediaSessionCopy): void {
  if (!('mediaSession' in navigator)) return
  const artwork512 = copy.artwork512 || DEFAULT_ARTWORK_512
  navigator.mediaSession.metadata = new MediaMetadata({
    title: copy.title,
    artist: copy.artist,
    album: copy.album,
    artwork: [
      { src: artwork512, sizes: '512x512', type: 'image/svg+xml' }
    ]
  })

  navigator.mediaSession.playbackState = 'playing'
  navigator.mediaSession.setActionHandler('play', () => {
    startBackgroundSession().catch(() => {})
    copy.onPlay?.()
    navigator.mediaSession.playbackState = 'playing'
  })
  navigator.mediaSession.setActionHandler('pause', () => {
    copy.onPause?.()
    navigator.mediaSession.playbackState = 'paused'
  })
  navigator.mediaSession.setActionHandler('stop', () => { copy.onStop?.() })
  if ('setPositionState' in navigator.mediaSession) {
    navigator.mediaSession.setPositionState({
      duration: Number.POSITIVE_INFINITY,
      playbackRate: 1,
      position: 0
    })
  }
}

export function clearMediaSession(): void {
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.playbackState = 'none'
  navigator.mediaSession.metadata = null
}

function attachVisibilityKeepAlive(): void {
  if (visibilityAttached) return
  visibilityAttached = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // Keep anchor media active to help lock-screen controller persistence.
      startBackgroundSession().catch(() => {})
      return
    }
    startBackgroundSession().catch(() => {})
  })
}

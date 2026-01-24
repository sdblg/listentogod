# ListenToGod

Low-latency live audio streaming optimized for **many listeners** using WebRTC peer-to-peer.

## Architecture

**Broadcast Model (Scales to 100+ Listeners):**
- **Host:** Captures audio once, sends a single SDP offer via signaling to all listeners
- **Each Listener:** Receives the offer, sends an answer (their own SDP), establishes a peer connection to the host
- **Host Bandwidth:** O(N) outbound connections (manageable on modern hardware)
- **Latency:** Sub-200ms typical on local Wi‑Fi

## Overview
- Backend: Go WebSocket signaling server (rooms, host broadcasts offer to all listeners)
- Frontend: React + Vite, WebRTC audio only
- Transport: Peer-to-peer WebRTC for low latency

## Run

### Backend

The server is already configured at `backend/cmd/app/main.go`. It should be running. To restart:

```bash
cd backend
go mod tidy
go run ./cmd/app/main.go
```

Expected output:
```
2026/01/23 18:06:33 Signaling server listening on :8080
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Expected output:
```
  VITE v5.4.21  ready in 453 ms
  ➜  Local:   http://localhost:5173/
```

## Testing on Wi‑Fi

**If your Mac has a managed firewall blocking ports:**

1. **On Host Mac**, find your IP: `ifconfig | grep "inet " | grep -v 127.0.0.1`
2. **Allow firewall access**:
   - System Settings → Network → Firewall → Options
   - Add `go` and `node` and set to "Allow incoming connections"
   
3. **On Host device:** Open `http://localhost:80`, go to **Host**, enter room name (e.g., `demo`), press **Start Broadcasting**
4. **On Listener device(s):** Scan the QR code OR open `http://[host-ip]:80/listen?room=demo`
5. Host's audio streams to all listeners with ~100-200ms latency

**Alternative (if firewall is locked):**
Use localhost only and share screen via AirPlay/HDMI for same-room testing.

## Backend Server Code

(Located in `backend/cmd/app/main.go` — already included, no paste needed)

```go
package main

import (
	"encoding/json"
	"log"
	"math/rand"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type Role string

const (
	RoleHost     Role = "host"
	RoleListener Role = "listener"
)

type wsClient struct {
	id      string
	room    string
	role    Role
	conn    *websocket.Conn
	outLock sync.Mutex
}

type inbound struct {
	Type    string          `json:"type"`
	To      string          `json:"to,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type outbound struct {
	Type    string          `json:"type"`
	From    string          `json:"from,omitempty"`
	To      string          `json:"to,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool { return true },
}

type room struct {
	HostID    string
	Listeners map[string]struct{}
}

type registry struct {
	mu    sync.RWMutex
	rooms map[string]*room
}

func newRegistry() *registry { return &registry{rooms: make(map[string]*room)} }
func (r *registry) setHost(name, hostID string) {
	r.mu.Lock(); defer r.mu.Unlock()
	rm := r.rooms[name]
	if rm == nil { rm = &room{Listeners: make(map[string]struct{})}; r.rooms[name] = rm }
	rm.HostID = hostID
}
func (r *registry) addListener(name, id string) {
	r.mu.Lock(); defer r.mu.Unlock()
	rm := r.rooms[name]
	if rm == nil { rm = &room{Listeners: make(map[string]struct{})}; r.rooms[name] = rm }
	rm.Listeners[id] = struct{}{}
}
func (r *registry) remove(name, id string) (wasHost bool, listenersLeft int) {
	r.mu.Lock(); defer r.mu.Unlock()
	rm := r.rooms[name]
	if rm == nil { return false, 0 }
	if rm.HostID == id { wasHost = true; rm.HostID = "" } else { delete(rm.Listeners, id) }
	listenersLeft = len(rm.Listeners)
	if rm.HostID == "" && listenersLeft == 0 { delete(r.rooms, name) }
	return
}
func (r *registry) getHost(name string) string { r.mu.RLock(); defer r.mu.RUnlock(); if rm:=r.rooms[name]; rm!=nil { return rm.HostID }; return "" }
func (r *registry) getListeners(name string) []string { r.mu.RLock(); defer r.mu.RUnlock(); rm:=r.rooms[name]; if rm==nil { return nil }; out:=make([]string,0,len(rm.Listeners)); for id := range rm.Listeners { out = append(out,id) }; return out }

func main() {
	reg := newRegistry()
	clients := struct {
		mu sync.RWMutex
		byID map[string]*wsClient
	}{byID: make(map[string]*wsClient)}

	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		room := r.URL.Query().Get("room")
		roleStr := r.URL.Query().Get("role")
		if room == "" || roleStr == "" {
			http.Error(w, "missing room or role", http.StatusBadRequest)
			return
		}
		var role Role
		if roleStr == string(RoleHost) { role = RoleHost } else { role = RoleListener }
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("websocket upgrade error: %v", err)
			return
		}
		client := &wsClient{ id: newID(), room: room, role: role, conn: c }

		clients.mu.Lock(); clients.byID[client.id] = client; clients.mu.Unlock()

		if client.role == RoleHost {
			reg.setHost(room, client.id)
			log.Printf("Host connected: room=%s id=%s", room, client.id)
		} else {
			reg.addListener(room, client.id)
			notifyHostListenerJoined(reg, clients, room, client.id)
			log.Printf("Listener connected: room=%s id=%s", room, client.id)
		}

		go readLoop(reg, clients, client)
	})

	addr := ":8080"
	log.Printf("Signaling server listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}

func readLoop(reg *registry, pool struct{ mu sync.RWMutex; byID map[string]*wsClient }, client *wsClient) {
	defer func() {
		client.conn.Close()
		pool.mu.Lock(); delete(pool.byID, client.id); pool.mu.Unlock()
		wasHost, listenersLeft := reg.remove(client.room, client.id)
		if wasHost {
			for _, lid := range reg.getListeners(client.room) {
				if target := getClient(pool, lid); target != nil {
					_ = send(target, outbound{Type: "host-left"})
				}
			}
		} else {
			hostID := reg.getHost(client.room)
			if host := getClient(pool, hostID); host != nil {
				_ = send(host, outbound{Type: "listener-left", From: client.id})
			}
		}
		log.Printf("Disconnected: room=%s id=%s wasHost=%v listenersLeft=%d", client.room, client.id, wasHost, listenersLeft)
	}()

	client.conn.SetReadLimit(1 << 20)
	client.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	client.conn.SetPongHandler(func(string) error { client.conn.SetReadDeadline(time.Now().Add(60 * time.Second)); return nil })

	for {
		_, data, err := client.conn.ReadMessage()
		if err != nil { break }
		var in inbound
		if err := json.Unmarshal(data, &in); err != nil { log.Printf("invalid json from %s: %v", client.id, err); continue }
		switch in.Type {
		case "offer", "answer", "ice":
			if in.To == "" { log.Printf("missing 'to' in message from %s type %s", client.id, in.Type); continue }
			if target := getClient(pool, in.To); target != nil {
				_ = send(target, outbound{Type: in.Type, From: client.id, To: in.To, Payload: in.Payload})
			} else { log.Printf("target %s not found in room %s", in.To, client.room) }
		default:
			log.Printf("unknown message type: %s", in.Type)
		}
	}
}

func notifyHostListenerJoined(reg *registry, pool struct{ mu sync.RWMutex; byID map[string]*wsClient }, room string, listenerID string) {
	hostID := reg.getHost(room)
	if hostID == "" { return }
	if host := getClient(pool, hostID); host != nil { _ = send(host, outbound{Type: "listener-joined", From: listenerID}) }
}

func getClient(pool struct{ mu sync.RWMutex; byID map[string]*wsClient }, id string) *wsClient {
	pool.mu.RLock(); defer pool.mu.RUnlock(); return pool.byID[id]
}

func send(c *wsClient, msg outbound) error { c.outLock.Lock(); defer c.outLock.Unlock(); return c.conn.WriteJSON(msg) }

func newID() string { rand.Seed(time.Now().UnixNano()); const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; b := make([]byte, 12); for i := range b { b[i] = letters[rand.Intn(len(letters))] }; return string(b) }
```

## Limitations & Future

- **Max listeners:** ~50–100 per host (limited by host's outbound bandwidth/CPU)
- **For 1000+ listeners:** Upgrade to an **SFU** (Selective Forwarding Unit) using [pion](https://github.com/pion/webrtc) or [ion-sfu](https://github.com/pion/ion-sfu)
- **Geographically distributed:** Use TURN servers (currently using public STUN)

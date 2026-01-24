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
	CheckOrigin:     func(r *http.Request) bool { return true },
}

type broadcastRoom struct {
	HostID    string
	Listeners map[string]*wsClient
	mu        sync.RWMutex
	hostConn  *wsClient
}

type registry struct {
	mu    sync.RWMutex
	rooms map[string]*broadcastRoom
}

func newRegistry() *registry { return &registry{rooms: make(map[string]*broadcastRoom)} }

func (r *registry) getOrCreateRoom(name string) *broadcastRoom {
	r.mu.Lock()
	defer r.mu.Unlock()
	room, ok := r.rooms[name]
	if !ok {
		room = &broadcastRoom{Listeners: make(map[string]*wsClient)}
		r.rooms[name] = room
	}
	return room
}

func (r *registry) setHost(name, hostID string, conn *wsClient) *broadcastRoom {
	room := r.getOrCreateRoom(name)
	room.mu.Lock()
	defer room.mu.Unlock()
	room.HostID = hostID
	room.hostConn = conn
	return room
}

func (r *registry) addListener(name string, listener *wsClient) *broadcastRoom {
	room := r.getOrCreateRoom(name)
	room.mu.Lock()
	defer room.mu.Unlock()
	room.Listeners[listener.id] = listener
	return room
}

func (r *registry) remove(name, id string) {
	r.mu.RLock()
	room := r.rooms[name]
	r.mu.RUnlock()

	if room == nil {
		return
	}

	room.mu.Lock()
	defer room.mu.Unlock()
	delete(room.Listeners, id)
	if room.HostID == id {
		room.HostID = ""
		room.hostConn = nil
	}

	// Clean up empty rooms
	if room.HostID == "" && len(room.Listeners) == 0 {
		r.mu.Lock()
		delete(r.rooms, name)
		r.mu.Unlock()
	}
}

func (r *registry) getHostConn(name string) *wsClient {
	r.mu.RLock()
	room := r.rooms[name]
	r.mu.RUnlock()
	if room == nil {
		return nil
	}
	room.mu.RLock()
	defer room.mu.RUnlock()
	return room.hostConn
}

func (r *registry) getListeners(name string) []*wsClient {
	r.mu.RLock()
	room := r.rooms[name]
	r.mu.RUnlock()
	if room == nil {
		return nil
	}
	room.mu.RLock()
	defer room.mu.RUnlock()
	out := make([]*wsClient, 0, len(room.Listeners))
	for _, listener := range room.Listeners {
		out = append(out, listener)
	}
	return out
}

func (r *registry) getListener(name, id string) *wsClient {
	r.mu.RLock()
	room := r.rooms[name]
	r.mu.RUnlock()
	if room == nil {
		return nil
	}
	room.mu.RLock()
	defer room.mu.RUnlock()
	return room.Listeners[id]
}

func main() {
	reg := newRegistry()

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
		if roleStr == string(RoleHost) {
			role = RoleHost
		} else {
			role = RoleListener
		}
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("websocket upgrade error: %v", err)
			return
		}
		client := &wsClient{
			id:   newID(),
			room: room,
			role: role,
			conn: c,
		}

		if client.role == RoleHost {
			reg.setHost(room, client.id, client)
			log.Printf("Host connected: room=%s id=%s", room, client.id)
			// Notify all existing listeners that host is ready
			for _, listener := range reg.getListeners(room) {
				_ = send(listener, outbound{Type: "host-ready"})
			}
		} else {
			reg.addListener(room, client)
			hostConn := reg.getHostConn(room)
			if hostConn != nil {
				_ = send(hostConn, outbound{Type: "listener-joined", From: client.id})
			}
			log.Printf("Listener connected: room=%s id=%s", room, client.id)
		}

		go readLoop(reg, client)
	})

	addr := ":8080"
	log.Printf("Signaling server listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}

func readLoop(reg *registry, client *wsClient) {
	defer func() {
		client.conn.Close()
		hostConn := reg.getHostConn(client.room)
		reg.remove(client.room, client.id)

		if client.role == RoleHost {
			// Host left - notify all listeners
			for _, listener := range reg.getListeners(client.room) {
				_ = send(listener, outbound{Type: "host-left"})
			}
			log.Printf("Host disconnected: room=%s id=%s", client.room, client.id)
		} else {
			// Listener left - notify host
			if hostConn != nil {
				_ = send(hostConn, outbound{Type: "listener-left", From: client.id})
			}
			log.Printf("Listener disconnected: room=%s id=%s", client.room, client.id)
		}
	}()

	client.conn.SetReadLimit(1 << 20)
	client.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	client.conn.SetPongHandler(func(string) error {
		client.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		_, data, err := client.conn.ReadMessage()
		if err != nil {
			break
		}
		var in inbound
		if err := json.Unmarshal(data, &in); err != nil {
			log.Printf("invalid json from %s: %v", client.id, err)
			continue
		}

		// Route signaling messages
		switch in.Type {
		case "offer":
			// If host sends offer, broadcast to all listeners
			if client.role == RoleHost {
				for _, listener := range reg.getListeners(client.room) {
					_ = send(listener, outbound{Type: "offer", From: client.id, Payload: in.Payload})
				}
			}
		case "answer":
			// If listener sends answer, route to host
			if client.role == RoleListener {
				hostConn := reg.getHostConn(client.room)
				if hostConn != nil {
					_ = send(hostConn, outbound{Type: "answer", From: client.id, To: hostConn.id, Payload: in.Payload})
				}
			}
		case "ice":
			// Route ICE candidates
			if in.To != "" {
				if client.role == RoleHost {
					// Host sends ICE to a specific listener
					if listener := reg.getListener(client.room, in.To); listener != nil {
						_ = send(listener, outbound{Type: "ice", From: client.id, Payload: in.Payload})
					}
				} else if client.role == RoleListener {
					// Listener sends ICE to host
					hostConn := reg.getHostConn(client.room)
					if hostConn != nil {
						_ = send(hostConn, outbound{Type: "ice", From: client.id, Payload: in.Payload})
					}
				}
			}
		default:
			log.Printf("unknown message type: %s", in.Type)
		}
	}
}

func send(c *wsClient, msg outbound) error {
	c.outLock.Lock()
	defer c.outLock.Unlock()
	return c.conn.WriteJSON(msg)
}

func newID() string {
	rand.Seed(time.Now().UnixNano())
	const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, 12)
	for i := range b {
		b[i] = letters[rand.Intn(len(letters))]
	}
	return string(b)
}

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
		client := &wsClient{
			id:   newID(),
			room: room,
			role: role,
			conn: c,
		}

		clients.mu.Lock()
		clients.byID[client.id] = client
		clients.mu.Unlock()

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

func readLoop(reg *registry, pool struct{
	mu   sync.RWMutex
	byID map[string]*wsClient
}, client *wsClient) {
	defer func() {
		client.conn.Close()
		pool.mu.Lock()
		delete(pool.byID, client.id)
		pool.mu.Unlock()
		wasHost, listenersLeft := reg.remove(client.room, client.id)
		if wasHost {
			// Inform all listeners host left
			for _, lid := range reg.getListeners(client.room) {
				if target := getClient(pool, lid); target != nil {
					_ = send(target, outbound{Type: "host-left"})
				}
			}
		} else {
			// Inform host listener left
			hostID := reg.getHost(client.room)
			if host := getClient(pool, hostID); host != nil {
				_ = send(host, outbound{Type: "listener-left", From: client.id})
			}
		}
		log.Printf("Disconnected: room=%s id=%s wasHost=%v listenersLeft=%d", client.room, client.id, wasHost, listenersLeft)
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
		case "offer", "answer", "ice":
			if in.To == "" {
				log.Printf("missing 'to' in message from %s type %s", client.id, in.Type)
				continue
			}
			if target := getClient(pool, in.To); target != nil {
				_ = send(target, outbound{Type: in.Type, From: client.id, To: in.To, Payload: in.Payload})
			} else {
				log.Printf("target %s not found in room %s", in.To, client.room)
			}
		default:
			log.Printf("unknown message type: %s", in.Type)
		}
	}
}

func notifyHostListenerJoined(reg *registry, pool struct{
	mu   sync.RWMutex
	byID map[string]*wsClient
}, room string, listenerID string) {
	hostID := reg.getHost(room)
	if hostID == "" {
		return
	}
	if host := getClient(pool, hostID); host != nil {
		_ = send(host, outbound{Type: "listener-joined", From: listenerID})
	}
}

func getClient(pool struct{
	mu   sync.RWMutex
	byID map[string]*wsClient
}, id string) *wsClient {
	pool.mu.RLock()
	defer pool.mu.RUnlock()
	return pool.byID[id]
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




































































































































































































}	return string(b)	}		b[i] = letters[rand.Intn(len(letters))]	for i := range b {	b := make([]byte, 12)	const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"	rand.Seed(time.Now().UnixNano())func newID() string {}	return c.conn.WriteJSON(msg)	defer c.outLock.Unlock()	c.outLock.Lock()func send(c *wsClient, msg outbound) error {}	return pool.byID[id]	defer pool.mu.RUnlock()	pool.mu.RLock()}, id string) *wsClient {	byID map[string]*wsClient	mu   sync.RWMutexfunc getClient(pool struct{}	}		_ = send(host, outbound{Type: "listener-joined", From: listenerID})	if host := getClient(pool, hostID); host != nil {	}		return	if hostID == "" {	hostID := reg.GetHost(room)}, room string, listenerID string) {	byID map[string]*wsClient	mu   sync.RWMutexfunc notifyHostListenerJoined(reg *signaling.Registry, pool struct{}	}		}			log.Printf("unknown message type: %s", in.Type)		default:			}				log.Printf("target %s not found in room %s", in.To, client.room)			} else {				_ = send(target, outbound{Type: in.Type, From: client.id, To: in.To, Payload: in.Payload})			if target := getClient(pool, in.To); target != nil {			}				continue				log.Printf("missing 'to' in message from %s type %s", client.id, in.Type)			if in.To == "" {		case "offer", "answer", "ice":		switch in.Type {		// Route signaling messages		}			continue			log.Printf("invalid json from %s: %v", client.id, err)		if err := json.Unmarshal(data, &in); err != nil {		var in inbound		}			break		if err != nil {		_, data, err := client.conn.ReadMessage()	for {	})		return nil		client.conn.SetReadDeadline(time.Now().Add(60 * time.Second))	client.conn.SetPongHandler(func(string) error {	client.conn.SetReadDeadline(time.Now().Add(60 * time.Second))	client.conn.SetReadLimit(1 << 20)	}()		log.Printf("Disconnected: room=%s id=%s wasHost=%v listenersLeft=%d", client.room, client.id, wasHost, listenersLeft)		}			}				_ = send(host, outbound{Type: "listener-left", From: client.id})			if host := getClient(pool, hostID); host != nil {			hostID := reg.GetHost(client.room)			// Inform host listener left		} else {			}				}					_ = send(target, outbound{Type: "host-left"})				if target := getClient(pool, lid); target != nil {			for _, lid := range reg.GetListeners(client.room) {			// Inform all listeners host left		if wasHost {		wasHost, listenersLeft := reg.Remove(client.room, client.id)		pool.mu.Unlock()		delete(pool.byID, client.id)		pool.mu.Lock()		client.conn.Close()	defer func() {}, client *wsClient) {	byID map[string]*wsClient	mu   sync.RWMutexfunc readLoop(reg *signaling.Registry, pool struct{}	log.Fatal(http.ListenAndServe(addr, nil))	log.Printf("Signaling server listening on %s", addr)	addr := ":8080"	})		go readLoop(reg, clients, client)		}			log.Printf("Listener connected: room=%s id=%s", room, client.id)			notifyHostListenerJoined(reg, clients, room, client.id)			reg.AddListener(room, client.id)		} else {			log.Printf("Host connected: room=%s id=%s", room, client.id)			reg.SetHost(room, client.id)		if client.role == signaling.RoleHost {		clients.mu.Unlock()		clients.byID[client.id] = client		clients.mu.Lock()		}			conn: c,			role: role,			room: room,			id:   newID(),		client := &wsClient{		}			return			log.Printf("websocket upgrade error: %v", err)		if err != nil {		c, err := upgrader.Upgrade(w, r, nil)		}			role = signaling.RoleListener		} else {			role = signaling.RoleHost		if roleStr == string(signaling.RoleHost) {		var role signaling.Role		}			return			http.Error(w, "missing room or role", http.StatusBadRequest)		if room == "" || roleStr == "" {		roleStr := r.URL.Query().Get("role")		room := r.URL.Query().Get("room")	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {	})		_, _ = w.Write([]byte("ok"))		w.WriteHeader(http.StatusOK)	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {	}{byID: make(map[string]*wsClient)}		byID map[string]*wsClient		mu sync.RWMutex	clients := struct {	reg := signaling.NewRegistry()func main() {}	CheckOrigin: func(r *http.Request) bool { return true },	WriteBufferSize: 4096,	ReadBufferSize:  4096,var upgrader = websocket.Upgrader{}	Payload json.RawMessage `json:"payload,omitempty"`	To      string          `json:"to,omitempty"`	From    string          `json:"from,omitempty"`	Type    string          `json:"type"`type outbound struct {}	Payload json.RawMessage `json:"payload,omitempty"`	To      string          `json:"to,omitempty"`	Type    string          `json:"type"`type inbound struct {}	outLock sync.Mutex	conn    *websocket.Conn	role    signaling.Role	room    string	id      stringtype wsClient struct {)	"listentogod/internal/signaling"	"github.com/gorilla/websocket"	"time"	"sync"	"net/http"	"math/rand"	"log"	"encoding/json"import (
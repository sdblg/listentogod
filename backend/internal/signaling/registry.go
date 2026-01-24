package signaling

import "sync"

type Role string

const (
	RoleHost     Role = "host"
	RoleListener Role = "listener"
)

type Client struct {
	ID   string
	Role Role
}

type Room struct {
	Name      string
	HostID    string
	Listeners map[string]struct{}
}

type Registry struct {
	mu    sync.RWMutex
	rooms map[string]*Room
}

func NewRegistry() *Registry {
	return &Registry{rooms: make(map[string]*Room)}
}

func (r *Registry) EnsureRoom(name string) *Room {
	r.mu.Lock()
	defer r.mu.Unlock()
	room, ok := r.rooms[name]
	if !ok {
		room = &Room{Name: name, Listeners: make(map[string]struct{})}
		r.rooms[name] = room
	}
	return room
}

func (r *Registry) SetHost(name, hostID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	room := r.rooms[name]
	if room == nil {
		room = &Room{Name: name, Listeners: make(map[string]struct{})}
		r.rooms[name] = room
	}
	room.HostID = hostID
}

func (r *Registry) AddListener(name, listenerID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	room := r.rooms[name]
	if room == nil {
		room = &Room{Name: name, Listeners: make(map[string]struct{})}
		r.rooms[name] = room
	}
	room.Listeners[listenerID] = struct{}{}
}

func (r *Registry) Remove(name, id string) (wasHost bool, listenersLeft int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	room := r.rooms[name]
	if room == nil {
		return false, 0
	}
	if room.HostID == id {
		wasHost = true
		room.HostID = ""
	} else {
		delete(room.Listeners, id)
	}
	listenersLeft = len(room.Listeners)
	if room.HostID == "" && listenersLeft == 0 {
		delete(r.rooms, name)
	}
	return
}

func (r *Registry) GetHost(name string) (hostID string) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if room := r.rooms[name]; room != nil {
		return room.HostID
	}
	return ""
}

func (r *Registry) GetListeners(name string) []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	room := r.rooms[name]
	if room == nil {
		return nil
	}
	out := make([]string, 0, len(room.Listeners))
	for id := range room.Listeners {
		out = append(out, id)
	}
	return out
}

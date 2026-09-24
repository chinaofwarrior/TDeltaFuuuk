package core

import (
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/chinaofwarrior/TDeltaFuuuk/internal/model"
)

type agentState struct {
	ID       string
	Name     string
	Role     string
	Frame    model.Frame
	LastSeen time.Time
}

type State struct {
	mu          sync.RWMutex
	agents      map[string]agentState
	local       *agentState
	timeout     time.Duration
	lastEvent   *model.Event
	lastEventAt time.Time
}

func New(timeout time.Duration) *State {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return &State{agents: make(map[string]agentState), timeout: timeout}
}

func (s *State) UpdateAgent(env model.AgentEnvelope) {
	if strings.TrimSpace(env.AgentID) == "" {
		return
	}
	now := time.Now()
	if env.Frame.TS == 0 {
		env.Frame.TS = now.UnixMilli()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	prev, ok := s.agents[env.AgentID]
	if ok {
		env.Frame = mergeFrame(prev.Frame, env.Frame)
	}
	name := strings.TrimSpace(env.Name)
	if name == "" {
		name = prev.Name
	}
	role := strings.TrimSpace(env.Role)
	if role == "" {
		role = prev.Role
	}
	s.agents[env.AgentID] = agentState{ID: env.AgentID, Name: name, Role: role, Frame: env.Frame, LastSeen: now}
	if env.Frame.Event != nil {
		e := *env.Frame.Event
		s.lastEvent = &e
		s.lastEventAt = now
	}
}

func (s *State) UpdateLocal(frame model.Frame) {
	now := time.Now()
	if frame.TS == 0 {
		frame.TS = now.UnixMilli()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.local != nil {
		frame = mergeFrame(s.local.Frame, frame)
	}
	s.local = &agentState{ID: "local", Name: "本机", Role: "host", Frame: frame, LastSeen: now}
	if frame.Event != nil {
		e := *frame.Event
		s.lastEvent = &e
		s.lastEventAt = now
	}
}

func (s *State) Snapshot() model.Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	now := time.Now()
	var states []agentState
	if s.local != nil && now.Sub(s.local.LastSeen) <= s.timeout {
		states = append(states, *s.local)
	}
	for _, a := range s.agents {
		if now.Sub(a.LastSeen) <= s.timeout {
			states = append(states, a)
		}
	}
	sort.Slice(states, func(i, j int) bool {
		if states[i].Role == states[j].Role {
			return states[i].ID < states[j].ID
		}
		return states[i].Role == "host"
	})

	out := model.Snapshot{Frame: model.Frame{TS: now.UnixMilli()}}
	if s.lastEvent != nil && now.Sub(s.lastEventAt) <= 250*time.Millisecond {
		e := *s.lastEvent
		out.Event = &e
	}

	var primary *agentState
	for i := range states {
		if states[i].Role == "host" {
			primary = &states[i]
			break
		}
	}
	if primary == nil && len(states) > 0 {
		primary = &states[0]
	}

	mateMap := map[string]model.Entity{}
	contactMap := map[string]model.Entity{}
	if primary != nil {
		if primary.Frame.Self != nil {
			e := *primary.Frame.Self
			out.Self = &e
		}
		for _, e := range primary.Frame.Teammates {
			upsertEntity(mateMap, e)
		}
	}
	for _, a := range states {
		if primary == nil || a.ID != primary.ID {
			if a.Frame.Self != nil {
				e := *a.Frame.Self
				if e.Name == "" {
					e.Name = a.Name
				}
				upsertEntity(mateMap, e)
			}
		}
		for _, e := range a.Frame.Contacts {
			upsertEntity(contactMap, e)
		}
	}

	out.Teammates = mapValuesSorted(mateMap)
	out.Contacts = mapValuesSorted(contactMap)

	for _, a := range states {
		out.Agents = append(out.Agents, model.AgentStatus{
			AgentID: a.ID, Name: a.Name, Role: a.Role,
			LastSeenMS: now.Sub(a.LastSeen).Milliseconds(), Online: true,
		})
	}
	return out
}

func MergeFrame(old, fresh model.Frame) model.Frame { return mergeFrame(old, fresh) }

func mergeFrame(old, fresh model.Frame) model.Frame {
	out := fresh
	if out.TS == 0 {
		out.TS = old.TS
	}
	if fresh.Self == nil {
		out.Self = old.Self
	} else if old.Self != nil {
		m := mergeEntity(*old.Self, *fresh.Self)
		out.Self = &m
	}
	if len(fresh.Teammates) == 0 {
		out.Teammates = old.Teammates
	}
	if len(fresh.Contacts) == 0 {
		out.Contacts = old.Contacts
	}
	if fresh.Event == nil {
		out.Event = old.Event
	}
	return out
}

func upsertEntity(m map[string]model.Entity, e model.Entity) {
	if strings.TrimSpace(e.ID) == "" {
		return
	}
	if old, ok := m[e.ID]; ok {
		m[e.ID] = mergeEntity(old, e)
		return
	}
	m[e.ID] = e
}

func mergeEntity(old, fresh model.Entity) model.Entity {
	out := fresh
	if out.Name == "" {
		out.Name = old.Name
	}
	if out.Action == "" {
		out.Action = old.Action
	}
	if out.Source == "" {
		out.Source = old.Source
	}
	if out.EquipmentSource == "" {
		out.EquipmentSource = old.EquipmentSource
	}
	if out.X == nil {
		out.X = old.X
	}
	if out.Y == nil {
		out.Y = old.Y
	}
	if out.Z == nil {
		out.Z = old.Z
	}
	if out.Yaw == nil {
		out.Yaw = old.Yaw
	}
	if out.HP == nil {
		out.HP = old.HP
	}
	if out.MaxHP == nil {
		out.MaxHP = old.MaxHP
	}
	if out.Confidence == nil {
		out.Confidence = old.Confidence
	}
	out.Equipment = mergeEquipment(old.Equipment, out.Equipment)
	out.Supplies = mergeSupplies(old.Supplies, out.Supplies)
	if out.TS == 0 {
		out.TS = old.TS
	}
	return out
}

func mergeEquipment(old, n model.Equipment) model.Equipment {
	if n.Primary == "" {
		n.Primary = old.Primary
	}
	if n.Secondary == "" {
		n.Secondary = old.Secondary
	}
	if n.Helmet == "" {
		n.Helmet = old.Helmet
	}
	if n.Armor == "" {
		n.Armor = old.Armor
	}
	if n.ArmorDurability == nil {
		n.ArmorDurability = old.ArmorDurability
	}
	if n.ArmorMax == nil {
		n.ArmorMax = old.ArmorMax
	}
	if n.Backpack == "" {
		n.Backpack = old.Backpack
	}
	if n.Optic == "" {
		n.Optic = old.Optic
	}
	if n.AmmoType == "" {
		n.AmmoType = old.AmmoType
	}
	if n.GearValue == nil {
		n.GearValue = old.GearValue
	}
	return n
}

func mergeSupplies(old, n model.Supplies) model.Supplies {
	if n.Ammo == nil {
		n.Ammo = old.Ammo
	}
	if n.Magazines == nil {
		n.Magazines = old.Magazines
	}
	if n.Medkits == nil {
		n.Medkits = old.Medkits
	}
	if n.Bandages == nil {
		n.Bandages = old.Bandages
	}
	if n.ArmorRepair == nil {
		n.ArmorRepair = old.ArmorRepair
	}
	if n.Grenades == nil {
		n.Grenades = old.Grenades
	}
	if n.Smoke == nil {
		n.Smoke = old.Smoke
	}
	if n.Food == nil {
		n.Food = old.Food
	}
	if n.Water == nil {
		n.Water = old.Water
	}
	if n.Value == nil {
		n.Value = old.Value
	}
	return n
}

func mapValuesSorted(m map[string]model.Entity) []model.Entity {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]model.Entity, 0, len(keys))
	for _, k := range keys {
		out = append(out, m[k])
	}
	return out
}

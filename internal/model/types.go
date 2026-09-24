package model

import "time"

type Equipment struct {
	Primary         string   `json:"primary,omitempty"`
	Secondary       string   `json:"secondary,omitempty"`
	Helmet          string   `json:"helmet,omitempty"`
	Armor           string   `json:"armor,omitempty"`
	ArmorDurability *float64 `json:"armorDurability,omitempty"`
	ArmorMax        *float64 `json:"armorMax,omitempty"`
	Backpack        string   `json:"backpack,omitempty"`
	Optic           string   `json:"optic,omitempty"`
	AmmoType        string   `json:"ammoType,omitempty"`
	GearValue       *float64 `json:"gearValue,omitempty"`
}

type Supplies struct {
	Ammo        *int     `json:"ammo,omitempty"`
	Magazines   *int     `json:"magazines,omitempty"`
	Medkits     *int     `json:"medkits,omitempty"`
	Bandages    *int     `json:"bandages,omitempty"`
	ArmorRepair *int     `json:"armorRepair,omitempty"`
	Grenades    *int     `json:"grenades,omitempty"`
	Smoke       *int     `json:"smoke,omitempty"`
	Food        *int     `json:"food,omitempty"`
	Water       *int     `json:"water,omitempty"`
	Value       *float64 `json:"value,omitempty"`
}

type Entity struct {
	ID              string    `json:"id"`
	Name            string    `json:"name,omitempty"`
	X               *float64  `json:"x,omitempty"`
	Y               *float64  `json:"y,omitempty"`
	Z               *float64  `json:"z,omitempty"`
	Yaw             *float64  `json:"yaw,omitempty"`
	Downed          bool      `json:"downed,omitempty"`
	Action          string    `json:"action,omitempty"`
	HP              *float64  `json:"hp,omitempty"`
	MaxHP           *float64  `json:"maxHp,omitempty"`
	Confidence      *float64  `json:"confidence,omitempty"`
	Source          string    `json:"source,omitempty"`
	EquipmentSource string    `json:"equipment_source,omitempty"`
	Equipment       Equipment `json:"equipment,omitempty"`
	Supplies        Supplies  `json:"supplies,omitempty"`
	TS              int64     `json:"ts,omitempty"`
}

type Event struct {
	Text  string `json:"text,omitempty"`
	Level string `json:"level,omitempty"`
}

type Frame struct {
	TS        int64    `json:"ts"`
	Self      *Entity  `json:"self,omitempty"`
	Teammates []Entity `json:"teammates,omitempty"`
	Contacts  []Entity `json:"contacts,omitempty"`
	Event     *Event   `json:"event,omitempty"`
}

type AgentEnvelope struct {
	AgentID string `json:"agent_id"`
	Name    string `json:"name,omitempty"`
	Role    string `json:"role,omitempty"`
	Frame   Frame  `json:"frame"`
}

type AgentStatus struct {
	AgentID    string `json:"agent_id"`
	Name       string `json:"name,omitempty"`
	Role       string `json:"role,omitempty"`
	LastSeenMS int64  `json:"last_seen_ms"`
	Online     bool   `json:"online"`
}

type Snapshot struct {
	Frame
	Agents []AgentStatus `json:"agents,omitempty"`
}

func NowMS() int64 { return time.Now().UnixMilli() }

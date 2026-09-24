package core

import (
	"testing"
	"time"

	"github.com/chinaofwarrior/TDeltaFuuuk/internal/model"
)

func intp(v int) *int           { return &v }
func floatp(v float64) *float64 { return &v }

func TestMergeKeepsEquipmentAndSupplies(t *testing.T) {
	s := New(time.Second)
	s.UpdateAgent(model.AgentEnvelope{AgentID: "a", Role: "host", Frame: model.Frame{Self: &model.Entity{ID: "me", Equipment: model.Equipment{Primary: "M4A1"}, Supplies: model.Supplies{Ammo: intp(120)}}}})
	s.UpdateAgent(model.AgentEnvelope{AgentID: "a", Role: "host", Frame: model.Frame{Self: &model.Entity{ID: "me", X: floatp(10), Y: floatp(20)}}})
	got := s.Snapshot()
	if got.Self == nil || got.Self.Equipment.Primary != "M4A1" || got.Self.Supplies.Ammo == nil || *got.Self.Supplies.Ammo != 120 {
		t.Fatalf("state lost across sparse update: %#v", got.Self)
	}
}

func TestSquadFusion(t *testing.T) {
	s := New(time.Second)
	s.UpdateAgent(model.AgentEnvelope{AgentID: "host", Role: "host", Frame: model.Frame{Self: &model.Entity{ID: "p1", Name: "一号"}, Contacts: []model.Entity{{ID: "e1", Name: "目标"}}}})
	s.UpdateAgent(model.AgentEnvelope{AgentID: "mate", Role: "member", Frame: model.Frame{Self: &model.Entity{ID: "p2", Name: "二号", X: floatp(5)}}})
	got := s.Snapshot()
	if got.Self == nil || got.Self.ID != "p1" {
		t.Fatalf("wrong primary: %#v", got.Self)
	}
	if len(got.Teammates) != 1 || got.Teammates[0].ID != "p2" {
		t.Fatalf("wrong mates: %#v", got.Teammates)
	}
	if len(got.Contacts) != 1 || got.Contacts[0].ID != "e1" {
		t.Fatalf("wrong contacts: %#v", got.Contacts)
	}
}

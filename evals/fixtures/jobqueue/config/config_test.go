package config

import (
	"strings"
	"testing"
)

func TestDefaultConfigurationIsUsable(t *testing.T) {
	if err := Default().Validate(); err != nil {
		t.Fatalf("default config should validate: %v", err)
	}
}

func TestLoadJSONAcceptsAValidConfiguration(t *testing.T) {
	loaded, err := LoadJSON(strings.NewReader(`{"queue_capacity":4,"workers":2,"max_retries":3,"retry_base_ms":10,"retry_max_ms":40,"storage_path":"queue.json","time_zone":"UTC","scheduler_tick_ms":5,"shutdown_timeout_ms":20}`))
	if err != nil {
		t.Fatalf("LoadJSON returned error: %v", err)
	}
	if loaded.QueueCapacity != 4 || loaded.Workers != 2 || loaded.MaxRetries != 3 {
		t.Fatalf("unexpected configuration: %#v", loaded)
	}
}

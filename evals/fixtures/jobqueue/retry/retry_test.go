package retry

import (
	"testing"
	"time"
)

func TestPolicyValidatesAndProducesADelay(t *testing.T) {
	policy := Policy{BaseDelay: time.Millisecond, MaxDelay: 10 * time.Millisecond}
	if err := policy.Validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if got := policy.Delay(2); got <= 0 {
		t.Fatalf("delay must be positive, got %v", got)
	}
}

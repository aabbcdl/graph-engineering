package events

import "testing"

func TestPublishDeliversAnEventToSubscribers(t *testing.T) {
	bus := New()
	seen := make(chan Event, 1)
	bus.Subscribe(func(event Event) { seen <- event })
	bus.Publish(Event{Type: JobEnqueued, JobID: "job-1"})
	got := <-seen
	if got.JobID != "job-1" || got.Type != JobEnqueued {
		t.Fatalf("unexpected event: %#v", got)
	}
}

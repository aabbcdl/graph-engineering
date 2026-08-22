package events

import (
	"context"
	"sync"
)

// Predicate decides whether an event satisfies a waiter.
type Predicate func(Event) bool

// Recorder keeps a bounded, caller-readable event history. It is intentionally
// separate from Bus so applications choose explicitly which event streams are
// retained in memory.
type Recorder struct {
	mu       sync.Mutex
	capacity int
	events   []Event
	changed  chan struct{}
}

// NewRecorder creates a bounded event recorder. Capacity is normalized to one
// so callers always retain the most recent event.
func NewRecorder(capacity int) *Recorder {
	if capacity < 1 {
		capacity = 1
	}
	return &Recorder{capacity: capacity, changed: make(chan struct{})}
}

// Handle implements Handler and may be registered directly with a Bus.
func (recorder *Recorder) Handle(event Event) {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	if len(recorder.events) == recorder.capacity {
		copy(recorder.events, recorder.events[1:])
		recorder.events[len(recorder.events)-1] = event
	} else {
		recorder.events = append(recorder.events, event)
	}
	recorder.signalLocked()
}

// Attach subscribes this recorder to a bus and returns the bus unsubscribe
// function. The returned function is safe to call repeatedly.
func (recorder *Recorder) Attach(bus *Bus) func() {
	if bus == nil {
		return func() {}
	}
	return bus.Subscribe(recorder.Handle)
}

// Snapshot returns a caller-owned copy ordered from oldest to newest.
func (recorder *Recorder) Snapshot() []Event {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return append([]Event(nil), recorder.events...)
}

// Last returns the newest retained event.
func (recorder *Recorder) Last() (Event, bool) {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	if len(recorder.events) == 0 {
		return Event{}, false
	}
	return recorder.events[len(recorder.events)-1], true
}

// Len reports the retained event count.
func (recorder *Recorder) Len() int {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return len(recorder.events)
}

// Wait blocks until predicate matches a retained event or ctx ends. Existing
// history is checked before waiting, which avoids a lost wake-up for callers
// that subscribe after the event was published.
func (recorder *Recorder) Wait(ctx context.Context, predicate Predicate) (Event, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if predicate == nil {
		return Event{}, context.Canceled
	}
	for {
		recorder.mu.Lock()
		for index := len(recorder.events) - 1; index >= 0; index-- {
			if predicate(recorder.events[index]) {
				event := recorder.events[index]
				recorder.mu.Unlock()
				return event, nil
			}
		}
		changed := recorder.changed
		recorder.mu.Unlock()
		select {
		case <-ctx.Done():
			return Event{}, ctx.Err()
		case <-changed:
		}
	}
}

// Clear removes retained events and wakes callers so they can reevaluate their
// predicates against the new history.
func (recorder *Recorder) Clear() {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	recorder.events = nil
	recorder.signalLocked()
}

func (recorder *Recorder) signalLocked() {
	close(recorder.changed)
	recorder.changed = make(chan struct{})
}

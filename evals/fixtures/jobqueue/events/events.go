// Package events provides synchronous lifecycle notifications for JobQueue.
package events

import (
	"sync"
	"time"
)

// Type identifies a queue lifecycle event.
type Type string

const (
	JobEnqueued     Type = "job_enqueued"
	JobStarted      Type = "job_started"
	JobSucceeded    Type = "job_succeeded"
	JobFailed       Type = "job_failed"
	JobRetried      Type = "job_retried"
	JobAcknowledged Type = "job_acknowledged"
)

// Event is passed to application-defined callbacks.
type Event struct {
	Type   Type
	JobID  string
	At     time.Time
	Detail string
}

// Handler receives an event. Handlers may call Subscribe or the returned
// unsubscribe function while an event is being delivered.
type Handler func(Event)

// Bus keeps a registry of event handlers.
type Bus struct {
	mu       sync.RWMutex
	nextID   uint64
	handlers map[uint64]Handler
}

// New creates an empty event bus.
func New() *Bus {
	return &Bus{handlers: make(map[uint64]Handler)}
}

// Subscribe registers handler and returns an idempotent unsubscribe function.
func (b *Bus) Subscribe(handler Handler) func() {
	if handler == nil {
		return func() {}
	}
	b.mu.Lock()
	id := b.nextID
	b.nextID++
	b.handlers[id] = handler
	b.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			b.mu.Lock()
			delete(b.handlers, id)
			b.mu.Unlock()
		})
	}
}

// Publish delivers one event to a stable subscriber snapshot. No application
// handler is invoked while the registry lock is held.
func (b *Bus) Publish(event Event) {
	if event.At.IsZero() {
		event.At = time.Now().UTC()
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, handler := range b.handlers {
		handler(event)
	}
}

// SubscriberCount returns the currently registered callback count.
func (b *Bus) SubscriberCount() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.handlers)
}

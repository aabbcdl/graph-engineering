package scheduler

import (
	"context"
	"errors"
	"testing"
	"time"

	"example.com/jobqueue/queue"
)

type hiddenTicker struct {
	events  chan time.Time
	stopped bool
}

func (ticker *hiddenTicker) Chan() <-chan time.Time { return ticker.events }
func (ticker *hiddenTicker) Stop()                  { ticker.stopped = true }

func TestHiddenSchedulerStopsTicker(t *testing.T) {
	original := newTicker
	tracked := &hiddenTicker{events: make(chan time.Time)}
	newTicker = func(time.Duration) ticker { return tracked }
	defer func() { newTicker = original }()
	schedule := New(queue.New(1), time.Hour)
	if err := schedule.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := schedule.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !tracked.stopped {
		t.Fatal("scheduler stop did not stop its ticker")
	}
}

func TestHiddenSchedulerRejectsSecondStart(t *testing.T) {
	original := newTicker
	newTicker = func(time.Duration) ticker { return &hiddenTicker{events: make(chan time.Time)} }
	defer func() { newTicker = original }()
	parent, cancel := context.WithCancel(context.Background())
	defer cancel()
	schedule := New(queue.New(1), time.Hour)
	if err := schedule.Start(parent); err != nil {
		t.Fatal(err)
	}
	if err := schedule.Start(parent); !errors.Is(err, ErrStarted) {
		t.Fatalf("second start got %v, want ErrStarted", err)
	}
	if err := schedule.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
}

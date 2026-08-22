package jobqueue_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"example.com/jobqueue/api"
	"example.com/jobqueue/config"
	"example.com/jobqueue/events"
	"example.com/jobqueue/queue"
	"example.com/jobqueue/retry"
	"example.com/jobqueue/scheduler"
	"example.com/jobqueue/store"
	"example.com/jobqueue/worker"
)

func TestHiddenConfigStoragePath(t *testing.T) {
	custom := filepath.Join(t.TempDir(), "custom.json")
	defer os.Remove("jobqueue.json")
	settings := config.Default()
	settings.StoragePath = custom
	service, err := api.New(settings, func(context.Context, queue.Job) error { return nil })
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	if _, err := service.Enqueue(context.Background(), api.EnqueueRequest{ID: "storage"}); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	if _, err := os.Stat(custom); err != nil {
		t.Fatalf("configured storage path was not written: %v", err)
	}
}

func TestHiddenConfigInvalidJSON(t *testing.T) {
	if _, err := config.LoadJSON(strings.NewReader("{")); err == nil {
		t.Fatal("invalid JSON must return an error")
	}
}

func TestHiddenEventCallbacksCanUnsubscribe(t *testing.T) {
	bus := events.New()
	var unsubscribe func()
	unsubscribe = bus.Subscribe(func(events.Event) { unsubscribe() })
	done := make(chan struct{})
	go func() {
		bus.Publish(events.Event{Type: events.JobEnqueued, JobID: "event"})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("publishing deadlocked when a callback unsubscribed")
	}
}

func TestHiddenQueueFIFO(t *testing.T) {
	jobs := queue.New(3)
	for _, id := range []string{"first", "second"} {
		if err := jobs.Enqueue(context.Background(), queue.Job{ID: id, Priority: 1}); err != nil {
			t.Fatalf("enqueue %s: %v", id, err)
		}
	}
	got, err := jobs.Dequeue(context.Background())
	if err != nil {
		t.Fatalf("dequeue: %v", err)
	}
	if got.ID != "first" {
		t.Fatalf("same-priority jobs must be FIFO, got %q", got.ID)
	}
}

func TestHiddenQueuePriority(t *testing.T) {
	jobs := queue.New(3)
	if err := jobs.Enqueue(context.Background(), queue.Job{ID: "low", Priority: 1}); err != nil {
		t.Fatal(err)
	}
	if err := jobs.Enqueue(context.Background(), queue.Job{ID: "high", Priority: 10}); err != nil {
		t.Fatal(err)
	}
	got, err := jobs.Dequeue(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "high" {
		t.Fatalf("higher priority job must run first, got %q", got.ID)
	}
}

func TestHiddenQueueEmptyWaitsForContext(t *testing.T) {
	jobs := queue.New(1)
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	_, err := jobs.Dequeue(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("empty dequeue must wait for context expiration, got %v", err)
	}
}

func TestHiddenQueueCloseWakesBlockedProducer(t *testing.T) {
	jobs := queue.New(1)
	if err := jobs.Enqueue(context.Background(), queue.Job{ID: "first"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- jobs.Enqueue(ctx, queue.Job{ID: "blocked"})
	}()
	time.Sleep(15 * time.Millisecond)
	jobs.Close()
	select {
	case err := <-result:
		if !errors.Is(err, queue.ErrClosed) {
			t.Fatalf("blocked producer got %v, want ErrClosed", err)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("closing a queue did not wake a blocked producer")
	}
}

func TestHiddenRetryFirstDelay(t *testing.T) {
	policy := retry.Policy{BaseDelay: 10 * time.Millisecond, MaxDelay: 100 * time.Millisecond}
	if got := policy.Delay(0); got != 10*time.Millisecond {
		t.Fatalf("first retry delay got %v, want 10ms", got)
	}
}

func TestHiddenRetryLimit(t *testing.T) {
	policy := retry.Policy{BaseDelay: time.Millisecond, MaxDelay: time.Second}
	if policy.ShouldRetry(3, 3) {
		t.Fatal("retry index equal to max attempts must be rejected")
	}
}

func TestHiddenRetryCap(t *testing.T) {
	policy := retry.Policy{BaseDelay: 10 * time.Millisecond, MaxDelay: 40 * time.Millisecond}
	if got := policy.Delay(5); got != 40*time.Millisecond {
		t.Fatalf("delay got %v, want capped 40ms", got)
	}
}

func TestHiddenStoreRenameError(t *testing.T) {
	target := t.TempDir()
	persistence := store.New(target)
	err := persistence.Save(context.Background(), []queue.Job{{ID: "rename"}})
	if err == nil {
		t.Fatal("replacing a directory with a snapshot must return an error")
	}
}

func TestHiddenStoreCorruption(t *testing.T) {
	path := filepath.Join(t.TempDir(), "corrupt.json")
	if err := os.WriteFile(path, []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.New(path).Load(context.Background()); err == nil {
		t.Fatal("corrupt snapshot must return an error")
	}
}

func TestHiddenStoreRestoresOrder(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ordered.json")
	persistence := store.New(path)
	input := []queue.Job{{ID: "first"}, {ID: "second"}}
	if err := persistence.Save(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	got, err := persistence.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ID != "first" || got[1].ID != "second" {
		t.Fatalf("recovery changed queue order: %#v", got)
	}
}

func TestHiddenSchedulerPreservesRetryDuration(t *testing.T) {
	jobs := queue.New(2)
	schedule := scheduler.New(jobs, time.Hour)
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	schedule.SetClock(func() time.Time { return now })
	if err := schedule.ScheduleRetry(queue.Job{ID: "retry"}, 100*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if err := schedule.Tick(context.Background(), now.Add(time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if got := jobs.Len(); got != 0 {
		t.Fatalf("retry became ready after 1ms instead of 100ms; queue length=%d", got)
	}
}

func TestHiddenSchedulerPreservesLocation(t *testing.T) {
	location, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skipf("time zone database unavailable: %v", err)
	}
	now := time.Date(2026, 11, 1, 7, 30, 0, 0, time.UTC)
	next, err := scheduler.NextDaily(location, 9, 0, now)
	if err != nil {
		t.Fatal(err)
	}
	if next.Location() != location {
		t.Fatalf("next local run lost its location: %s", next.Location())
	}
}

func TestHiddenWorkerRetryDoesNotSurviveStop(t *testing.T) {
	jobs := queue.New(2)
	bus := events.New()
	retried := make(chan struct{}, 1)
	bus.Subscribe(func(event events.Event) {
		if event.Type == events.JobRetried {
			select {
			case retried <- struct{}{}:
			default:
			}
		}
	})
	pool, err := worker.New(jobs, retry.Policy{BaseDelay: 50 * time.Millisecond, MaxDelay: 100 * time.Millisecond}, bus, 1, func(context.Context, queue.Job) error {
		return errors.New("retry")
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Start(); err != nil {
		t.Fatal(err)
	}
	if err := jobs.Enqueue(context.Background(), queue.Job{ID: "retry-after-stop", MaxAttempts: 1}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-retried:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("worker did not schedule a retry")
	}
	time.Sleep(10 * time.Millisecond)
	stopCtx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := pool.Stop(stopCtx); err != nil {
		t.Fatalf("stop: %v", err)
	}
	time.Sleep(150 * time.Millisecond)
	if got := jobs.Len(); got != 0 {
		t.Fatalf("retry was enqueued after shutdown; queue length=%d", got)
	}
}

func newHiddenService(t *testing.T, capacity int) *api.Service {
	t.Helper()
	defer os.Remove("jobqueue.json")
	settings := config.Default()
	settings.QueueCapacity = capacity
	settings.StoragePath = filepath.Join(t.TempDir(), "queue.json")
	service, err := api.New(settings, func(context.Context, queue.Job) error { return nil })
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	return service
}

func TestHiddenAckUnknownJob(t *testing.T) {
	service := newHiddenService(t, 2)
	if err := service.Ack(context.Background(), "unknown"); !errors.Is(err, api.ErrUnknownJob) {
		t.Fatalf("unknown acknowledgement got %v, want ErrUnknownJob", err)
	}
}

func TestHiddenAckEventOrder(t *testing.T) {
	service := newHiddenService(t, 2)
	job, err := service.Enqueue(context.Background(), api.EnqueueRequest{ID: "ack-order"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Dequeue(context.Background()); err != nil {
		t.Fatal(err)
	}
	seen := make(chan int, 1)
	service.Events().Subscribe(func(event events.Event) {
		if event.Type == events.JobAcknowledged {
			seen <- service.Stats().InFlight
		}
	})
	if err := service.Ack(context.Background(), job.ID); err != nil {
		t.Fatal(err)
	}
	if got := <-seen; got != 1 {
		t.Fatalf("acknowledgement observers must see one in-flight job, got %d", got)
	}
}

func TestHiddenStatsUtilization(t *testing.T) {
	service := newHiddenService(t, 4)
	if _, err := service.Enqueue(context.Background(), api.EnqueueRequest{ID: "utilization"}); err != nil {
		t.Fatal(err)
	}
	if got := service.Stats().Utilization; got != 0.25 {
		t.Fatalf("utilization got %v, want 0.25", got)
	}
}

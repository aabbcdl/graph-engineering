package api

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"example.com/jobqueue/config"
	"example.com/jobqueue/queue"
)

func TestServiceEnqueueDequeueAndAck(t *testing.T) {
	defer os.Remove("jobqueue.json")
	cfg := config.Default()
	cfg.StoragePath = filepath.Join(t.TempDir(), "jobs.json")
	service, err := New(cfg, func(context.Context, queue.Job) error { return nil })
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	job, err := service.Enqueue(context.Background(), EnqueueRequest{ID: "job-1", Payload: "work"})
	if err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	dequeued, err := service.Dequeue(context.Background())
	if err != nil || dequeued.ID != job.ID {
		t.Fatalf("dequeue got %#v, %v", dequeued, err)
	}
	if err := service.Ack(context.Background(), job.ID); err != nil {
		t.Fatalf("ack: %v", err)
	}
	stats := service.Stats()
	if stats.Completed != 1 || stats.InFlight != 0 {
		t.Fatalf("unexpected stats: %#v", stats)
	}
	stopCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := service.Stop(stopCtx); err != nil {
		t.Fatalf("stop: %v", err)
	}
}

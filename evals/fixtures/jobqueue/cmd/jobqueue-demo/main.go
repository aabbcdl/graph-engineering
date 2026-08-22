package main

import (
	"context"
	"fmt"
	"log"
	"os"

	"example.com/jobqueue/api"
	"example.com/jobqueue/config"
	"example.com/jobqueue/queue"
)

func main() {
	settings := config.Default()
	settings.StoragePath = "jobqueue-demo.json"
	service, err := api.New(settings, func(_ context.Context, job queue.Job) error {
		fmt.Printf("processed %s: %s\n", job.ID, job.Payload)
		return nil
	})
	if err != nil {
		log.Fatal(err)
	}
	defer os.Remove(settings.StoragePath)
	job, err := service.Enqueue(context.Background(), api.EnqueueRequest{ID: "demo", Payload: "hello"})
	if err != nil {
		log.Fatal(err)
	}
	dequeued, err := service.Dequeue(context.Background())
	if err != nil {
		log.Fatal(err)
	}
	if err := service.Ack(context.Background(), dequeued.ID); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("acknowledged %s; completed=%d\n", job.ID, service.Stats().Completed)
}

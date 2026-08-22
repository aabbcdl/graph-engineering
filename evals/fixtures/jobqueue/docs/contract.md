# JobQueue Contract

This document defines the externally observable behavior of the library. The
API is deliberately small, but callers depend on its ordering, cancellation,
durability, and lifecycle guarantees.

## Configuration

`config.Config` has safe defaults, but explicitly supplied values must remain
effective after normalization and JSON loading. Queue capacity, worker count,
retry limits, retry delays, storage path, scheduler tick, and shutdown timeout
must be positive. Invalid JSON or invalid values must return an error rather
than silently selecting defaults. A custom `StoragePath` must be used by the
file store.

## Queue

`queue.Queue` is bounded and safe for concurrent callers. It accepts a job only
once it owns an independent copy of that job and its metadata. Higher priority
jobs are dequeued first. Jobs of the same priority are FIFO. `Dequeue` waits
for a job, queue closure, or context cancellation; it must not busy-spin or
return an empty result before one of those conditions. Closing the queue wakes
blocked producers and consumers. Snapshots are safe caller-owned copies.

## Retries

`retry.Policy` uses exponential backoff. Retry index zero waits exactly
`BaseDelay`; every subsequent index doubles the prior delay, and the result is
never greater than `MaxDelay`. A job with `MaxAttempts = n` may be retried for
indices `0` through `n-1`, but never for index `n`. A retry scheduled for a
duration must not be converted between duration units.

## Events

Callbacks registered with `events.Bus` may subscribe or unsubscribe while an
event is being delivered. Publishing must not deadlock or hold the subscriber
registry lock while calling application code. `JobAcknowledged` is emitted
before the acknowledged item disappears from API-visible in-flight state, so an
observer can inspect it consistently.

## Persistence

`store.FileStore` writes a versioned JSON snapshot atomically. Write, sync,
close, and rename failures are returned to the caller. A corrupt snapshot is
not an empty queue. Loading preserves stored ordering and returns independent
job copies. File handles are closed on both successful and failed reads.

## Workers and shutdown

`worker.Pool` starts no more than its configured worker count and can be started
only once. `Stop` waits for workers and outstanding retry delays, honors the
caller context, and prevents a retry from being enqueued after shutdown. A
worker observes queue closure and cancellation promptly.

## Scheduler

The scheduler moves jobs to the queue no earlier than their requested time. It
can be started once, stops its ticker when stopped, and does not enqueue a job
twice because of concurrent starts. `NextDaily` preserves the supplied
location, including daylight-saving transitions, rather than treating local
clock input as UTC.

## API

`api.Service` owns queued and in-flight state. `Enqueue` uses the configured
retry limit and storage path. `Dequeue` makes a job in-flight. `Ack` rejects an
unknown ID, emits the acknowledgement event while the job is still observable
as in-flight, then records it as completed. `Stats` reports queue capacity,
queued, in-flight, completed, and utilization as `queued / capacity`.

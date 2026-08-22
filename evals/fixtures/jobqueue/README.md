# JobQueue

JobQueue is a small, file-backed work queue for background jobs. It is intended
for applications that need bounded queues, predictable retries, durable restart
recovery, and graceful worker shutdown without external dependencies.

The public contract is described in [docs/contract.md](docs/contract.md).

## Required checks

```text
go build ./...
go test ./...
```

The repository uses only the Go standard library. A supported Go toolchain must
be available on `PATH` when running the checks.

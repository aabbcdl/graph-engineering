package retry

import (
	"errors"
	"time"

	"example.com/jobqueue/queue"
)

// Classification describes whether a handler error is eligible for automatic
// retry. Applications can use it to distinguish permanent validation failures
// from transient delivery failures.
type Classification string

const (
	Permanent Classification = "permanent"
	Transient Classification = "transient"
	Unknown   Classification = "unknown"
)

// ClassifiedError allows handlers to state retry behavior without coupling to
// a particular transport or storage implementation.
type ClassifiedError interface {
	error
	RetryClassification() Classification
}

// RetryAfterError lets a dependency supply a minimum delay, for example from a
// rate-limit response. The policy delay remains an upper-level safeguard.
type RetryAfterError interface {
	error
	RetryAfter() time.Duration
}

// Error wraps a cause with an explicit retry classification and optional
// server-directed retry delay.
type Error struct {
	Cause error
	Class Classification
	After time.Duration
}

func (err Error) Error() string {
	if err.Cause == nil {
		return string(err.Class)
	}
	return err.Cause.Error()
}

func (err Error) Unwrap() error {
	return err.Cause
}

// RetryClassification implements ClassifiedError.
func (err Error) RetryClassification() Classification {
	return err.Class
}

// RetryAfter implements RetryAfterError.
func (err Error) RetryAfter() time.Duration {
	return err.After
}

// Classify maps well-described errors to their explicit classification. Errors
// without metadata are Unknown so applications may choose their own policy.
func Classify(err error) Classification {
	if err == nil {
		return Permanent
	}
	var classified ClassifiedError
	if errors.As(err, &classified) {
		switch class := classified.RetryClassification(); class {
		case Permanent, Transient:
			return class
		default:
			return Unknown
		}
	}
	return Unknown
}

// IsRetryable returns true only for explicitly transient or unspecified
// errors. Permanent handler errors are never scheduled again.
func IsRetryable(err error) bool {
	class := Classify(err)
	return class == Transient || class == Unknown
}

// DelayForError combines exponential policy delay with a handler-specified
// minimum. The result never exceeds policy.MaxDelay.
func (policy Policy) DelayForError(attempt int, err error) time.Duration {
	delay := policy.Delay(attempt)
	var retryAfter RetryAfterError
	if errors.As(err, &retryAfter) && retryAfter.RetryAfter() > delay {
		delay = retryAfter.RetryAfter()
	}
	if delay > policy.MaxDelay {
		return policy.MaxDelay
	}
	return delay
}

// NextForError is the error-aware counterpart to Next.
func (policy Policy) NextForError(job queue.Job, err error) (queue.Job, time.Duration, bool) {
	if !IsRetryable(err) || !policy.ShouldRetry(job.Attempt, job.MaxAttempts) {
		return job.Clone(), 0, false
	}
	next := job.Clone()
	delay := policy.DelayForError(next.Attempt, err)
	next.Attempt++
	return next, delay, true
}

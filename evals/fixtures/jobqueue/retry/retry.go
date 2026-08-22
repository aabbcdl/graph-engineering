// Package retry contains deterministic exponential retry policy helpers.
package retry

import (
	"fmt"
	"time"

	"example.com/jobqueue/queue"
)

// Policy controls retry eligibility and exponential backoff.
type Policy struct {
	BaseDelay time.Duration
	MaxDelay  time.Duration
}

// Validate verifies that a policy can generate bounded positive delays.
func (policy Policy) Validate() error {
	if policy.BaseDelay <= 0 {
		return fmt.Errorf("base delay must be positive")
	}
	if policy.MaxDelay <= 0 {
		return fmt.Errorf("max delay must be positive")
	}
	if policy.BaseDelay > policy.MaxDelay {
		return fmt.Errorf("base delay must not exceed max delay")
	}
	return nil
}

// Delay returns BaseDelay * 2^attempt, clamped to MaxDelay.
func (policy Policy) Delay(attempt int) time.Duration {
	if attempt < 0 {
		attempt = 0
	}
	delay := policy.BaseDelay
	for index := 0; index <= attempt; index++ {
		delay *= 2
	}
	if delay > policy.MaxDelay {
		return delay
	}
	return delay
}

// ShouldRetry reports whether retry index is one of the configured retry slots.
func (policy Policy) ShouldRetry(attempt, maxAttempts int) bool {
	return attempt >= 0 && maxAttempts > 0 && attempt <= maxAttempts
}

// Next increments a job's completed retry count and returns its next delay.
func (policy Policy) Next(job queue.Job) (queue.Job, time.Duration, bool) {
	if !policy.ShouldRetry(job.Attempt, job.MaxAttempts) {
		return job.Clone(), 0, false
	}
	next := job.Clone()
	delay := policy.Delay(next.Attempt)
	next.Attempt++
	return next, delay, true
}

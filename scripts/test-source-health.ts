import assert from "node:assert/strict";
import { SourceHealthChecker } from "../server/core/services/sourceHealth";

const checker = new SourceHealthChecker({
  maxFailures: 3,
  failureWindowMs: 300_000,
  circuitBreakerTimeoutMs: 60_000,
  responseTimeThresholdMs: 10_000,
});

// Intermittent failures in one breaker window must still trip the circuit.
checker.recordFailure("gotopan", { errorCategory: "timeout_error", errorMessage: "timeout 1" });
checker.recordSuccess("gotopan", 100, { resultCount: 1 });
checker.recordFailure("gotopan", { errorCategory: "timeout_error", errorMessage: "timeout 2" });
checker.recordSuccess("gotopan", 100, { resultCount: 1 });
checker.recordFailure("gotopan", { errorCategory: "timeout_error", errorMessage: "timeout 3" });
assert.equal(checker.getStatus("gotopan")?.circuitState, "open");
assert.equal(checker.canExecute("gotopan"), false);

// A late success from a request admitted before opening must not close it.
const race = new SourceHealthChecker({
  maxFailures: 2,
  failureWindowMs: 300_000,
  circuitBreakerTimeoutMs: 60_000,
  responseTimeThresholdMs: 10_000,
});
assert.equal(race.canExecute("ucquark"), true);
assert.equal(race.canExecute("ucquark"), true);
race.recordFailure("ucquark", { errorCategory: "timeout_error", errorMessage: "timeout 1" });
race.recordFailure("ucquark", { errorCategory: "timeout_error", errorMessage: "timeout 2" });
assert.equal(race.getStatus("ucquark")?.circuitState, "open");
race.recordSuccess("ucquark", 100, { resultCount: 1 });
assert.equal(race.getStatus("ucquark")?.circuitState, "open");
assert.equal(race.canExecute("ucquark"), false);

// A half-open recovery probe is allowed to close the circuit.
const recovery = new SourceHealthChecker({
  maxFailures: 1,
  failureWindowMs: 300_000,
  circuitBreakerTimeoutMs: 0,
  responseTimeThresholdMs: 10_000,
});
recovery.recordFailure("source", { errorCategory: "timeout_error" });
assert.equal(recovery.canExecute("source"), true);
recovery.recordSuccess("source", 100, { resultCount: 1 });
assert.equal(recovery.getStatus("source")?.circuitState, "closed");

console.log("source health circuit checks passed");

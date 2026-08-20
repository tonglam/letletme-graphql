#!/usr/bin/env python3
"""Evaluate one 30-second P0 production observation sample."""

from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path


SAMPLE_SECONDS = 30
SUSTAINED_SAMPLES = math.ceil(300 / SAMPLE_SECONDS)
LABEL_RE = re.compile(r'([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"])*)"')


def prometheus(path: Path, metric: str) -> list[tuple[dict[str, str], float]]:
    rows: list[tuple[dict[str, str], float]] = []
    prefix = metric + "{"
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith(prefix):
            continue
        closing = line.find("}")
        if closing < 0:
            continue
        labels = {key: value for key, value in LABEL_RE.findall(line[len(metric) + 1 : closing])}
        try:
            value = float(line[closing + 1 :].strip())
        except ValueError:
            continue
        rows.append((labels, value))
    return rows


def graph_ql_status_counts(path: Path) -> dict[str, float]:
    result: dict[str, float] = {}
    for labels, value in prometheus(path, "http_request_duration_seconds_count"):
        if labels.get("method") != "POST" or labels.get("route") != "/graphql":
            continue
        status = labels.get("status", "unknown")
        result[status] = result.get(status, 0.0) + value
    return result


def graph_ql_histogram(path: Path) -> dict[float, float]:
    result: dict[float, float] = {}
    for labels, value in prometheus(path, "http_request_duration_seconds_bucket"):
        if (
            labels.get("method") != "POST"
            or labels.get("route") != "/graphql"
            or labels.get("status") == "429"
        ):
            continue
        raw_bound = labels.get("le")
        if raw_bound is None:
            continue
        bound = math.inf if raw_bound == "+Inf" else float(raw_bound)
        result[bound] = result.get(bound, 0.0) + value
    return result


def delta(current: dict[float, float], previous: dict[float, float]) -> dict[float, float]:
    return {
        bound: max(0.0, value - previous.get(bound, 0.0))
        for bound, value in current.items()
    }


def quantile(histogram: dict[float, float], percentile: float) -> float | None:
    if not histogram:
        return None
    total = histogram.get(math.inf, max(histogram.values(), default=0.0))
    if total <= 0:
        return None
    target = total * percentile
    previous_bound = 0.0
    previous_count = 0.0
    for bound, cumulative in sorted(histogram.items()):
        if cumulative < target:
            if math.isfinite(bound):
                previous_bound = bound
            previous_count = cumulative
            continue
        if not math.isfinite(bound):
            return previous_bound
        bucket_count = cumulative - previous_count
        if bucket_count <= 0:
            return bound
        fraction = max(0.0, min(1.0, (target - previous_count) / bucket_count))
        return previous_bound + (bound - previous_bound) * fraction
    return None


def percentage(value: object) -> float:
    return float(str(value or "0").strip().rstrip("%"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--previous", type=Path, required=True)
    parser.add_argument("--current", type=Path, required=True)
    parser.add_argument("--stats", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--health-status", type=int, required=True)
    args = parser.parse_args()

    state = (
        json.loads(args.state.read_text(encoding="utf-8"))
        if args.state.exists()
        else {"bad5xx": 0, "dbWaiting": 0, "cpu": 0, "memory": 0, "samples": 0}
    )
    previous_status = graph_ql_status_counts(args.previous)
    current_status = graph_ql_status_counts(args.current)
    status_delta = {
        status: max(0.0, value - previous_status.get(status, 0.0))
        for status, value in current_status.items()
    }
    non_429_total = sum(value for status, value in status_delta.items() if status != "429")
    non_429_5xx = sum(
        value for status, value in status_delta.items() if status != "429" and status.startswith("5")
    )
    error_rate = non_429_5xx / non_429_total if non_429_total else 0.0

    baseline_p95 = quantile(graph_ql_histogram(args.baseline), 0.95)
    interval_p95 = quantile(
        delta(graph_ql_histogram(args.current), graph_ql_histogram(args.previous)), 0.95
    )
    waiting_rows = prometheus(args.current, "postgres_pool_clients")
    waiting = next((value for labels, value in waiting_rows if labels.get("state") == "waiting"), None)
    stats = json.loads(args.stats.read_text(encoding="utf-8"))
    cpu = percentage(stats.get("CPUPerc"))
    memory = percentage(stats.get("MemPerc"))

    state["samples"] = int(state.get("samples", 0)) + 1
    state["bad5xx"] = int(state.get("bad5xx", 0)) + 1 if non_429_total and error_rate > 0.01 else 0
    state["dbWaiting"] = int(state.get("dbWaiting", 0)) + 1 if waiting is not None and waiting > 0 else 0
    state["cpu"] = int(state.get("cpu", 0)) + 1 if cpu > 80 else 0
    state["memory"] = int(state.get("memory", 0)) + 1 if memory > 85 else 0

    reasons: list[str] = []
    if args.health_status != 200:
        reasons.append(f"health returned {args.health_status}")
    if waiting is None:
        reasons.append("postgres pool waiting metric is missing")
    if state["bad5xx"] >= SUSTAINED_SAMPLES:
        reasons.append("non-429 5xx exceeded 1% for five minutes")
    if state["dbWaiting"] >= 2:
        reasons.append("PostgreSQL pool waiting was non-zero for two samples")
    if state["cpu"] >= SUSTAINED_SAMPLES:
        reasons.append("CPU exceeded 80% for five minutes")
    if state["memory"] >= SUSTAINED_SAMPLES:
        reasons.append("memory exceeded 85% for five minutes")
    if interval_p95 is not None and interval_p95 > 1.0:
        reasons.append(f"GraphQL p95 exceeded one second: {interval_p95:.3f}s")
    if (
        interval_p95 is not None
        and baseline_p95 is not None
        and baseline_p95 > 0
        and interval_p95 >= baseline_p95 * 2
    ):
        reasons.append(
            f"GraphQL p95 reached twice baseline: {interval_p95:.3f}s vs {baseline_p95:.3f}s"
        )

    report = {
        **state,
        "healthStatus": args.health_status,
        "non429Requests": non_429_total,
        "non4295xxRate": error_rate,
        "baselineP95Seconds": baseline_p95,
        "intervalP95Seconds": interval_p95,
        "poolWaiting": waiting,
        "cpuPercent": cpu,
        "memoryPercent": memory,
        "passed": not reasons,
        "reasons": reasons,
    }
    args.output.write_text(json.dumps(report, separators=(",", ":")) + "\n", encoding="utf-8")
    return 0 if not reasons else 1


if __name__ == "__main__":
    raise SystemExit(main())

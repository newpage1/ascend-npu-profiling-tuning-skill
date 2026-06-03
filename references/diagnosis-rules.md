# Diagnosis Rules

Use these rules to turn profiler artifacts into tuning hypotheses.

## Timeline

- Long blank NPU periods: host launch overhead, data loader stalls, blocking synchronization, scheduler gaps, or rank skew.
- Repeated tiny ops: fusion opportunity, graph capture/compile opportunity, or batching issue.
- Long host-only spans before device work: preprocessing, tokenizer, request scheduler, Python overhead, or CPU contention.
- Device work serialized across streams: implicit sync, stream misuse, unsupported async path, or dependency chain.

## Operator Hotspots

- High self NPU time and high call count: candidate for fusion, shape stabilization, batching, or custom kernel work.
- High memory bandwidth with low arithmetic utilization: layout, tiling, dtype, alignment, or redundant copy issue.
- High arithmetic utilization but poor end-to-end throughput: upstream/downstream bottleneck, launch gaps, communication, or memory allocation churn.
- Frequent dynamic shapes: compile/cache misses, graph fragmentation, or poor batching buckets.

## Memory

- HBM near capacity: reduce batch/concurrency, enable cache reuse, tune KV cache block size, lower precision where valid, or reduce activation retention.
- Repeated allocation/free in timeline: preallocate buffers, reuse workspace, avoid shape churn.
- Host-device copies on critical path: pin or stage host data, remove unnecessary `.cpu()`/`.item()`/sync calls, keep tensors on NPU.

## Distributed

- HCCL communication longer than compute: overlap compute/comm, bucket sizes, topology placement, rank mapping, or algorithm selection.
- Rank skew: input imbalance, per-rank CPU stalls, heterogeneous cards, NUMA/network placement, or retry/error path.
- All ranks idle together: global barrier, scheduler bottleneck, data source bottleneck.

## LLM Serving

- Poor prefill: attention/kernel bottleneck, long prompt batching policy, KV allocation, tokenizer/preprocess bottleneck.
- Poor decode: KV cache layout, batch scheduler, small-op launch overhead, sampling/postprocess, communication in tensor parallel.
- High tail latency only: queueing policy, request size variance, memory pressure, background compaction, or noisy shared host.

## Reporting Template

```text
Finding: <measured bottleneck>
Evidence: <artifact path + metric>
Hypothesis: <why this hurts the target metric>
Change: <single proposed change>
Expected movement: <latency/throughput/utilization direction>
Validation: <exact command and comparison metric>
```

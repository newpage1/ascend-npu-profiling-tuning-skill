# Workload Flows

## vLLM / vLLM-Ascend

- First capture the fixed benchmark scenario without profiler.
- For system symptoms, use `remote_msprof_capture.sh` with the physical IDs backing the vLLM workers.
- For PyTorch-level trace, launch vLLM with its profiler support when available and write traces to a shared run directory. Keep vLLM prefill and decode captures separate when the workload allows it.
- Record server launch command, `--profiler-config`, model path, TP/DP settings, visible devices, and benchmark client command.

Common tuning levers:

- scheduler limits, max batched tokens, max seq len, block size, KV cache memory utilization, DBO/spec decode options when supported, graph/compile settings, attention backend, tensor parallel/rank mapping.

## MindIE / ACL / Black-Box Serving

- Use `msprof` as the primary capture path.
- Prefer short dynamic capture windows around a known request burst.
- When attaching to a running process, record PID, duration, device IDs, endpoint workload, and approval that profiling the process is acceptable.

Common tuning levers:

- batch/concurrency, model config, engine cache, graph build settings, HCCL/rank mapping, host preprocessing, memory pools, precision/quantization mode.

## PyTorch Training Or Inference

- Use `torch_npu.profiler.profile` when `torch_npu` is available inside the conda environment or workload container.
- Keep the active profiler window small and bracket only steady-state iterations.
- Use `msprof` in parallel only for a separate run unless overhead is acceptable.

Common tuning levers:

- data loader, host-device transfers, dynamic shape buckets, graph capture/compile, operator fusion, layout, dtype, HCCL overlap, gradient bucket sizes.

## Custom Ascend C Operator

- Use `msprof op` / `msprof op simulator` for operator-level evidence.
- Capture input shape, dtype, tiling, format, kernel version, and expected numerical tolerance.
- Compare against a baseline operator or framework implementation before claiming a kernel win.

Common tuning levers:

- tiling, UB/L2 use, memory coalescing/alignment, vectorization, pipeline overlap, workspace reuse, format conversion removal.

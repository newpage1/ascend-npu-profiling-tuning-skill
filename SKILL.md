---
name: ascend-npu-profiling-tuning
description: Use when profiling, benchmarking, or tuning workloads on Huawei Ascend NPU software stacks, especially when the work must run on a remote NPU host. Covers closed-loop performance engineering with SSH preflight, baseline measurement, torch_npu.profiler or msprof data collection, artifact pullback, bottleneck analysis, tuning hypotheses, and repeatable re-test.
metadata:
  short-description: Closed-loop remote Ascend NPU profiling and tuning
---

# Ascend NPU Profiling and Tuning

Use this skill for engineering-loop performance work on Ascend NPU systems: remote benchmark setup, profiling capture, artifact retrieval, bottleneck diagnosis, tuning, and re-measurement.

## Public Workflow

There is one public workflow: `remote-loop`.

Use `remote-loop` to drive the same closed loop every time:

```text
preflight -> discover devices -> baseline -> targeted profile -> collect artifacts -> summarize -> decide one tuning hypothesis -> re-run -> compare -> report
```

Do not skip the baseline or artifact summary unless the user only asks for environment bring-up.

Preferred entrypoints:

- `scripts/remote_preflight.sh`: remote environment and tool check.
- `scripts/remote_discover_devices.sh`: parse `npu-smi info`, map board/chip/phy IDs, and identify free physical IDs for `msprof --sys-devices`.
- `scripts/remote_msprof_capture.sh`: run a bounded remote `msprof` system/application capture and write a manifest.
- `scripts/collect_artifacts.sh`: pull remote artifacts back.
- `scripts/summarize_msprof_run.py`: render `summary.json` and `summary.md` from local msprof artifacts.
- `scripts/update_run_ledger.py`: append normalized JSONL run records and render a ledger markdown.
- `scripts/compare_msprof_summaries.py`: compare before/after profiler summaries.

## Evidence Standards

- Every measured claim must point to an artifact path, command, and run ID.
- For serving work, keep prefill and decode evidence separate when the workload can be split.
- Reports must include the same three Ascend tables:
  - **Resource Table**: HBM bandwidth, NPU memory, AICPU/control CPU idle, and visible device scope.
  - **Bottleneck/Overlap Table**: host gaps, HCCL/communication, device idle, launch/scheduler symptoms, or `N/A` when the capture cannot answer.
  - **Tuning Opportunity Table**: one-row-per-hypothesis with evidence, change, expected movement, and validation command.
- Keep failed candidates and failed profiler attempts in the ledger with the failure reason.
- Never present a tuning as successful until the same benchmark metric improves in a comparable re-run.

## Workflow Steps

1. **Define the run envelope**
   - Ask for or infer: remote SSH target, remote workspace, workload command, device count, model/input shape, batch/concurrency, warmup/measured iterations, and success metric.
   - If the target may be production or shared, confirm allowed devices, time window, output directory, and whether profiling overhead is acceptable.
   - Treat every run as an experiment. Record the exact command, git SHA, relevant environment variables, NPU visibility, CANN/torch-npu versions, and hardware topology.

2. **Remote preflight**
   - Prefer `scripts/remote_preflight.sh <ssh-target>` before any benchmark.
   - Confirm `npu-smi`, Python, PyTorch, `torch_npu`, CANN env, `msprof`, disk space, and visible devices.
   - Run `scripts/remote_discover_devices.sh <ssh-target>` before using `msprof --sys-devices`; use physical chip/device IDs, not only board IDs.
   - If required tools are missing, read `references/install-ascend-stack.md` and install only on an approved remote Ascend Linux host. Do not install CANN or torch-npu on a local non-Ascend workstation just because the commands are missing. Install Python packages only in conda or a container, never into global/system Python; create the default conda env `ascend-prof` when no env is specified.
   - Stop if the workload cannot run cleanly without profiling after installation or environment sourcing.

3. **Baseline first**
   - Run a no-profiler baseline with warmup and stable inputs.
   - Capture latency/throughput, error rate, NPU utilization, HBM usage, and host CPU symptoms.
   - Do not start tuning until the baseline is reproducible enough to compare against later runs.

4. **Choose the profiling path**
   - **PyTorch training or inference**: use `torch_npu.profiler.profile` with CPU and NPU activities. Use Level0 for low overhead, Level1 for CANN/AI Core/HCCL insight, Level2 when runtime or AI CPU detail is needed.
   - **Black-box ACL/offline inference or non-PyTorch process**: use `scripts/remote_msprof_capture.sh` or direct `msprof` collection from the CANN/MindStudio toolchain after checking `msprof --help` on the remote host.
   - **Custom Ascend C operator**: use `msprof op` or `msprof op simulator` for memory heatmap, roofline, instruction pipeline, and code hotspot analysis.
   - **Distributed workload**: collect per-rank logs and profiler output. Include HCCL communication files when using profiler levels that emit them.
   - **Serving workload**: measure both steady-state throughput and tail latency. Keep profiler windows short and targeted.

5. **Collect artifacts**
   - Use a per-run directory such as `profiling_runs/<timestamp>-<case>/`.
   - Pull back logs, manifest, benchmark summary, profiler DB/CSV/JSON, `trace_view.json`, HCCL files, and config patches.
   - Prefer `scripts/collect_artifacts.sh <ssh-target> <remote-run-dir> <local-dir>`.
   - After pulling artifacts, run `scripts/summarize_msprof_run.py <local-run-dir>` for msprof runs and append the result with `scripts/update_run_ledger.py append`.

6. **Analyze bottlenecks**
   - Start with timeline gaps: host launch stalls, data loading, synchronization, device idle periods, and rank skew.
   - Then inspect top operators by self NPU time, frequency, shape, memory traffic, and AI Core metrics.
   - For distributed runs, compare compute time vs communication time and look for imbalance or serialization.
   - For serving, separate prefill, decode, scheduler, KV cache, tokenizer, network, and postprocess time.

7. **Tune one hypothesis at a time**
   - Write a hypothesis before editing: expected bottleneck, proposed change, expected metric movement.
   - Change one meaningful variable per run when possible.
   - Re-run the baseline metric first, then profile only if the metric movement is real or surprising.
   - Keep a run ledger: `run_id`, change, command, result, artifacts, conclusion, next action.

8. **Report**
   - Lead with the measured before/after result and confidence.
   - Link local artifact paths and remote run paths.
   - Separate facts from inference. State when a conclusion comes from profiler data, logs, or a hypothesis.
   - Return the three Ascend tables even when some sections are `N/A`; absence of evidence is part of the report.

## References

Load only the reference needed for the task:

- `references/ascend-tools.md`: tool selection, `torch_npu.profiler`, `msprof`, MindStudio Insight, and official-doc pointers.
- `references/install-ascend-stack.md`: guarded installation workflow when remote profiling tools are missing.
- `references/diagnosis-rules.md`: bottleneck patterns and tuning levers.
- `references/remote-runbook.md`: remote execution conventions, artifact layout, and safety checks.
- `references/workload-flows.md`: vLLM/MindIE/PyTorch/custom-op profiling branch guidance.

## Bundled Scripts

- `scripts/remote_preflight.sh`: inspect a remote Ascend host before profiling.
- `scripts/remote_discover_devices.sh`: discover board/chip/physical IDs and free devices.
- `scripts/remote_msprof_capture.sh`: run a bounded remote msprof capture.
- `scripts/remote_install_ascend_stack.sh`: install CANN run packages and torch/torch-npu wheels from an explicit package directory; Python wheels require a conda environment.
- `scripts/remote_run_profile.sh`: run a remote command in a timestamped profiling directory with logs and manifest.
- `scripts/collect_artifacts.sh`: pull back a remote run directory with `rsync` or `scp`.
- `scripts/summarize_msprof_run.py`: summarize msprof exported CSV/JSON/DB artifacts into `summary.json` and `summary.md`.
- `scripts/update_run_ledger.py`: maintain normalized JSONL and markdown run history.
- `scripts/compare_msprof_summaries.py`: compare two msprof summaries for before/after checks.

Read a script before patching it. Keep remote commands explicit, logged, and scoped to a run directory.

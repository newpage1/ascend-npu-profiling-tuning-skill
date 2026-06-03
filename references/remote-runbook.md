# Remote Runbook

## Required Inputs

- SSH target, for example `user@host` or an SSH config alias.
- Remote workspace path.
- Workload command and expected success signal.
- Device selection policy: `ASCEND_RT_VISIBLE_DEVICES`, `NPU_VISIBLE_DEVICES`, container device mapping, or scheduler allocation.
- Local artifact directory.

For `msprof --sys-devices`, verify the local device numbering on the target host. On multi-chip Ascend 910 systems, `npu-smi info` may show board-level NPU IDs and chip/Phy-ID values; `msprof --sys-devices` can correspond to the physical chip/device ID rather than the leftmost board ID. Choose the free physical IDs, not just the free board rows.

## Run Directory

Use one directory per experiment:

```text
profiling_runs/
  20260530-153000-prefill-bs8/
    manifest.txt
    stdout.log
    stderr.log
    benchmark.json
    env.txt
    torch_npu/
    msprof/
    notes.md
```

The manifest should include:

- remote host and working directory
- command
- git commit and dirty state
- Python, PyTorch, torch-npu, CANN versions
- visible devices and `npu-smi info`
- warmup/measured iterations
- profiler settings

## Remote Safety

- Do not overwrite an existing run directory.
- Do not run profiler on production traffic unless explicitly approved.
- Do not collect secrets, request payloads, or customer data unless explicitly required and approved.
- Keep profile windows short. Large traces can fill disks quickly.
- Check free disk before capture and clean only run directories created for the current task.

## Recommended Commands

When the SSH target needs a key or non-default options:

```bash
export ASCEND_SSH_OPTS="-i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new"
```

Preflight:

```bash
scripts/remote_preflight.sh user@host
```

Discover physical IDs and free devices:

```bash
scripts/remote_discover_devices.sh user@host table
```

System-level msprof smoke capture on the first free physical device:

```bash
scripts/remote_msprof_capture.sh user@host /root/profiling_runs smoke auto 5
```

Run a workload command without profiler:

```bash
scripts/remote_run_profile.sh user@host /path/to/workspace 20260530-153000-case 'python bench.py --warmup 10 --iters 50'
```

Collect:

```bash
scripts/collect_artifacts.sh user@host /path/to/workspace/profiling_runs/20260530-153000-case ./artifacts/20260530-153000-case
```

Summarize, append ledger, and compare:

```bash
scripts/summarize_msprof_run.py ./artifacts/20260530-153000-case
scripts/update_run_ledger.py append --ledger ./artifacts/runs.jsonl --run-id 20260530-153000-case --case prefill-bs8 --summary-json ./artifacts/20260530-153000-case/summary.json
scripts/update_run_ledger.py render --ledger ./artifacts/runs.jsonl --output ./artifacts/runs.md
scripts/compare_msprof_summaries.py ./artifacts/before/summary.json ./artifacts/after/summary.json --output ./artifacts/compare.md
```

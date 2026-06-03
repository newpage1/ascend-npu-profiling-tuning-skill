# Ascend Tool Selection

## PyTorch path

Use `torch_npu.profiler.profile` when the workload is PyTorch-based and can be instrumented. The official Ascend PyTorch profiler API supports CPU and NPU activities; the NPU activity samples CANN software stack and NPU data. It also supports schedules, `tensorboard_trace_handler`, shape recording, memory profiling, stack/module information, FLOPs, and experimental config.

Important knobs:

- `ProfilerActivity.CPU`: framework-side events.
- `ProfilerActivity.NPU`: CANN software stack and NPU events.
- `ProfilerLevel.Level0`: lower-detail capture.
- `ProfilerLevel.Level1`: adds CANN AscendCL data, AI Core metrics, and HCCL communication files when applicable.
- `ProfilerLevel.Level2`: adds deeper runtime and AI CPU data.
- `AiCMetrics.PipeUtilization`, arithmetic utilization, memory bandwidth, UB, L2 cache, or resource conflict metrics depending on local version support.
- `msprof_tx`: enable custom marks when the installed torch-npu version supports it.
- `data_simplification`: reduce exported data size when the full framework directory is not needed.

Minimal PyTorch instrumentation shape:

```python
import torch
import torch_npu
from torch_npu.profiler import profile, ProfilerActivity, schedule, tensorboard_trace_handler
from torch_npu.profiler import _ExperimentalConfig, ProfilerLevel, AiCMetrics

prof_dir = "./profiling_runs/current/torch_npu"
experimental_config = _ExperimentalConfig(
    profiler_level=ProfilerLevel.Level1,
    aic_metrics=AiCMetrics.PipeUtilization,
)

with profile(
    activities=[ProfilerActivity.CPU, ProfilerActivity.NPU],
    schedule=schedule(wait=2, warmup=2, active=4, repeat=1),
    on_trace_ready=tensorboard_trace_handler(prof_dir),
    record_shapes=True,
    profile_memory=False,
    with_stack=False,
    experimental_config=experimental_config,
) as prof:
    for step, batch in enumerate(loader):
        run_one_step(batch)
        prof.step()
```

Keep active windows short for serving workloads. If stack or memory profiling changes timing too much, run a second targeted capture instead of enabling every option in the main profile.

## msprof path

Use `msprof` for non-PyTorch processes, ACL/offline inference, or when process-level tool wrapping is easier than code instrumentation. Always run `msprof --help` or `msprof <subcommand> --help` on the remote host because flags vary by CANN version.

For custom Ascend C operator work, prefer `msprof op` or `msprof op simulator`:

- `msprof op`: on-board operator tuning; useful for memory heatmap and roofline analysis in MindStudio Insight.
- `msprof op simulator`: simulator mode; useful for instruction pipeline and operator code hotspot analysis.

Do not start more than one profiling task on the same device. Validate that the target app runs normally before wrapping it with profiler collection.

## MindStudio Insight

Use MindStudio Insight for visual inspection of large timeline and operator data. It can load profiling outputs such as PyTorch `trace_view.json` and msprof JSON files and supports cluster-style timeline inspection. For very large runs, prefer a narrow capture window and keep a local summary so the analysis is not dependent on GUI access.

## Official Pointers

- Ascend PyTorch profiler API: https://www.hiascend.com/document/detail/en/mindstudio/700/TITools/Profiling/atlasprofiling_16_0033.html
- torch_npu.profiler.profile API: https://www.hiascend.com/document/detail/zh/Pytorch/2600/apiref/torchnpuCustomsapi/docs/zh/custom_APIs/torch_npu-profiler/torch_npu-profiler-profile.md
- MindStudio Insight overview: https://www.hiascend.com/document/detail/zh/mindstudio/82RC1/GUI_baseddevelopmenttool/msascendinsightug/Insight_userguide_0002.html
- msProf operator tuning overview: https://www.hiascend.com/document/detail/en/mindstudio/700/optools/Operatordevelopmenttools/atlasopdev_16_0082.html
- msProf tool usage: https://www.hiascend.com/document/detail/en/canncommercial/800/devaids/optool/atlasopdev_16_00851.html

# Installing Missing Ascend Profiling Tools

Install only after a remote preflight proves the target is an Ascend Linux environment or an intended Ascend development host. Do not guess package versions: CANN, driver/firmware, PyTorch, torch-npu, Python, OS architecture, and chip type must be compatible.

## What Provides Each Tool

- `npu-smi`: Ascend driver package. If missing on a physical Ascend host, driver/firmware installation or host device mapping is incomplete.
- `msprof` / `msopprof`: CANN toolkit / MindStudio operator tooling.
- `torch_npu`: Ascend Extension for PyTorch Python package.
- `torch_npu.profiler`: installed with `torch_npu`; depends on a working CANN environment.

## Installation Policy

1. Prefer user-provided official packages already staged on the remote host.
2. If packages are not staged, ask for the exact CANN run package path or approved download URL/version. Official docs direct users to obtain packages such as `Ascend-cann-toolkit_<version>_linux-<arch>.run` and `Ascend-cann-kernels-<chip_type>_<version>_linux-<arch>.run`.
3. For torch-npu, choose the package that matches the installed PyTorch, Python ABI, CPU architecture, CANN version, and torch-npu release compatibility matrix.
4. Install Python packages only into a conda environment or inside the target container. Do not run `pip install` against global/system Python, and do not create a plain virtualenv as the default path. If no conda environment is specified, create/use the default `ascend-prof` environment.
5. Never silently install with `sudo`. Ask for approval and use the remote host's expected install user.
6. After installation, source the CANN environment script and re-run `scripts/remote_preflight.sh`.

## Scripted Install From Staged Packages

Use the installer script when packages are already in a remote directory:

```bash
scripts/remote_install_ascend_stack.sh user@host /remote/packages ascend-prof
```

If the third argument is omitted and Python wheels are present, the script creates or reuses the default conda environment `ascend-prof`.

The script will:

- install executable CANN `.run` packages found in the package directory using `--install`;
- source the common CANN `set_env.sh` location when present;
- install matching `torch*.whl` and `torch_npu*.whl` files only into the provided or default conda environment;
- validate imports and NPU availability.

For containerized workloads, install `torch` / `torch_npu` inside the same container image or container runtime environment that will run the benchmark. The host-side script should be used only for CANN package staging and host-level `msprof` validation unless it is explicitly adapted to the container command.

Review the package list before running. The script intentionally does not auto-download opaque binaries.

## Official Pointers

- CANN package installation: https://www.hiascend.com/document/detail/en/canncommercial/800/softwareinst/instg/instg_0008.html
- CANN toolkit package form and install command: https://www.hiascend.com/document/detail/en/canncommercial/800/softwareinst/instg/instg_0054.html
- Ascend Extension for PyTorch installation overview: https://www.hiascend.com/document/detail/zh/Pytorch/700/configandinstg/instg/insg_0001.html
- torch-npu binary package installation: https://www.hiascend.com/document/detail/zh/Pytorch/730/configandinstg/instg/docs/zh/installation_guide/installation_via_binary_package_abi1.md

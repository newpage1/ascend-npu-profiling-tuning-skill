#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <ssh-target>" >&2
  exit 2
fi

target="$1"
read -r -a ssh_opts <<< "${ASCEND_SSH_OPTS:-}"

ssh "${ssh_opts[@]}" "$target" 'bash -s' <<'REMOTE'
set -euo pipefail

echo "## host"
hostname
date -Is || date
uname -a

echo
echo "## devices"
if command -v npu-smi >/dev/null 2>&1; then
  npu-smi info || true
else
  echo "npu-smi: not found"
fi

echo
echo "## toolchain"
for cmd in python3 python msprof msopprof; do
  if command -v "$cmd" >/dev/null 2>&1; then
    printf "%s: " "$cmd"
    command -v "$cmd"
  else
    echo "$cmd: not found"
  fi
done

echo
echo "## python packages"
pybin="$(command -v python3 || command -v python || true)"
if [[ -n "${pybin}" ]]; then
  "$pybin" - <<'PY' || true
import importlib
import os
import sys

print("python:", sys.version.replace("\n", " "))
for name in ("torch", "torch_npu"):
    try:
        mod = importlib.import_module(name)
        print(f"{name}:", getattr(mod, "__version__", "unknown"))
    except Exception as exc:
        print(f"{name}: unavailable ({exc.__class__.__name__}: {exc})")

for key in (
    "ASCEND_HOME_PATH",
    "ASCEND_TOOLKIT_HOME",
    "ASCEND_OPP_PATH",
    "LD_LIBRARY_PATH",
    "PATH",
    "ASCEND_RT_VISIBLE_DEVICES",
    "NPU_VISIBLE_DEVICES",
):
    value = os.environ.get(key)
    if value:
        print(f"{key}={value}")
PY
fi

echo
echo "## capacity"
df -h .
ulimit -a || true
REMOTE

#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 <ssh-target> <remote-package-dir> [conda-env-name-or-path]" >&2
  echo "If omitted, the conda environment defaults to: ascend-prof" >&2
  exit 2
fi

target="$1"
remote_package_dir="$2"
conda_env="${3:-ascend-prof}"
read -r -a ssh_opts <<< "${ASCEND_SSH_OPTS:-}"

ssh "${ssh_opts[@]}" "$target" 'bash -s' -- "$remote_package_dir" "$conda_env" <<'REMOTE'
set -euo pipefail

package_dir="$1"
conda_env="$2"

if [[ ! -d "$package_dir" ]]; then
  echo "Package directory does not exist: $package_dir" >&2
  exit 1
fi

echo "## package directory"
find "$package_dir" -maxdepth 1 -type f \( -name 'Ascend-cann-*.run' -o -name 'torch*.whl' -o -name 'torch_npu*.whl' -o -name 'torch_npu*.zip' \) -print | sort

echo
echo "## install CANN run packages"
shopt -s nullglob
for pkg in "$package_dir"/Ascend-cann-*.run; do
  echo "Installing $pkg"
  chmod +x "$pkg"
  "$pkg" --install
done

echo
echo "## source CANN environment"
for env_file in \
  "$HOME/Ascend/ascend-toolkit/set_env.sh" \
  "$HOME/Ascend/ascend-toolkit/latest/set_env.sh" \
  "/usr/local/Ascend/ascend-toolkit/set_env.sh" \
  "/usr/local/Ascend/ascend-toolkit/latest/set_env.sh"; do
  if [[ -f "$env_file" ]]; then
    echo "Sourcing $env_file"
    # shellcheck disable=SC1090
    set +u
    source "$env_file"
    set -u
    break
  fi
done

echo
echo "## python environment"
torch_wheels=("$package_dir"/torch-*.whl)
torch_npu_wheels=("$package_dir"/torch_npu*.whl)
has_python_wheels=0
if (( ${#torch_wheels[@]} || ${#torch_npu_wheels[@]} )) || compgen -G "$package_dir/torch_npu*.zip" >/dev/null; then
  has_python_wheels=1
fi

if (( has_python_wheels )); then
  conda_sh=""
  for candidate in \
    "$HOME/miniconda3/etc/profile.d/conda.sh" \
    "$HOME/anaconda3/etc/profile.d/conda.sh" \
    "/opt/conda/etc/profile.d/conda.sh" \
    "/usr/local/conda/etc/profile.d/conda.sh" \
    "/usr/local/miniconda3/etc/profile.d/conda.sh" \
    "/usr/local/anaconda3/etc/profile.d/conda.sh"; do
    if [[ -f "$candidate" ]]; then
      conda_sh="$candidate"
      break
    fi
  done

  if [[ -z "$conda_sh" ]]; then
    echo "conda.sh not found. Install inside the workload container or provide a host with conda." >&2
    exit 1
  fi

  # shellcheck disable=SC1090
  source "$conda_sh"

  if [[ "$conda_env" == */* ]]; then
    if [[ ! -d "$conda_env" ]]; then
      conda create -y -p "$conda_env" python=3.9
    fi
    conda activate "$conda_env"
  else
    if ! conda env list | awk '{print $1}' | grep -Fx "$conda_env" >/dev/null; then
      conda create -y -n "$conda_env" python=3.9
    fi
    conda activate "$conda_env"
  fi

  python -m pip install --upgrade pip

  if (( ${#torch_wheels[@]} )); then
    python -m pip install "${torch_wheels[@]}"
  fi

  if (( ${#torch_npu_wheels[@]} )); then
    python -m pip install "${torch_npu_wheels[@]}"
  elif compgen -G "$package_dir/torch_npu*.zip" >/dev/null; then
    tmp_dir="$(mktemp -d)"
    for zip_pkg in "$package_dir"/torch_npu*.zip; do
      unzip -o "$zip_pkg" -d "$tmp_dir"
    done
    python -m pip install "$tmp_dir"/torch_npu*.whl
  fi
fi

echo
echo "## validation"
if (( has_python_wheels )); then
python - <<'PY'
import importlib

for name in ("torch", "torch_npu"):
    mod = importlib.import_module(name)
    print(f"{name}: {getattr(mod, '__version__', 'unknown')}")

import torch
import torch_npu

print("torch_npu imported")
print("npu_available:", torch_npu.npu.is_available())
PY
else
  echo "No Python wheels found; skipped Python package validation."
fi

if command -v npu-smi >/dev/null 2>&1; then
  npu-smi info || true
fi

if command -v msprof >/dev/null 2>&1; then
  msprof --help >/dev/null 2>&1 || true
  echo "msprof: $(command -v msprof)"
else
  echo "msprof: not found after install"
fi
REMOTE

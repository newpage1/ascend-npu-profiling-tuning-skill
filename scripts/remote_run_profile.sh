#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 4 ]]; then
  echo "Usage: $0 <ssh-target> <remote-workdir> <run-id> <command...>" >&2
  exit 2
fi

target="$1"
remote_workdir="$2"
run_id="$3"
shift 3
run_command="$*"
read -r -a ssh_opts <<< "${ASCEND_SSH_OPTS:-}"

ssh "${ssh_opts[@]}" "$target" 'bash -s' -- "$remote_workdir" "$run_id" "$run_command" <<'REMOTE'
set -euo pipefail

remote_workdir="$1"
run_id="$2"
run_command="$3"

cd "$remote_workdir"
run_root="${ASCEND_PROFILE_ROOT:-$remote_workdir/profiling_runs}/$run_id"

if [[ -e "$run_root" ]]; then
  echo "Run directory already exists: $run_root" >&2
  exit 1
fi

mkdir -p "$run_root"

{
  echo "run_id=$run_id"
  echo "host=$(hostname)"
  echo "date=$(date -Is || date)"
  echo "workdir=$remote_workdir"
  echo "command=$run_command"
  echo "git_head=$(git rev-parse HEAD 2>/dev/null || true)"
  echo "git_status=$(git status --short 2>/dev/null | wc -l | tr -d " ")"
  echo "ASCEND_RT_VISIBLE_DEVICES=${ASCEND_RT_VISIBLE_DEVICES:-}"
  echo "NPU_VISIBLE_DEVICES=${NPU_VISIBLE_DEVICES:-}"
} > "$run_root/manifest.txt"

env | sort > "$run_root/env.txt"

if command -v npu-smi >/dev/null 2>&1; then
  npu-smi info > "$run_root/npu-smi-before.txt" 2>&1 || true
fi

export ASCEND_WORK_PATH="$run_root/ascend_work"
mkdir -p "$ASCEND_WORK_PATH"

set +e
bash -lc "$run_command" > "$run_root/stdout.log" 2> "$run_root/stderr.log"
status=$?
set -e

if command -v npu-smi >/dev/null 2>&1; then
  npu-smi info > "$run_root/npu-smi-after.txt" 2>&1 || true
fi

echo "$status" > "$run_root/exit_status.txt"
echo "$run_root"
exit "$status"
REMOTE

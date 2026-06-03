#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  remote_msprof_capture.sh <ssh-target> <remote-root> <case-name> [devices|auto] [duration-seconds] [application-command...]

Examples:
  remote_msprof_capture.sh user@host /root/profiling_runs smoke auto 5
  remote_msprof_capture.sh user@host /root/profiling_runs bench 10,11 20 'ASCEND_RT_VISIBLE_DEVICES=10,11 python bench.py'
EOF
}

if [[ $# -lt 3 ]]; then
  usage
  exit 2
fi

target="$1"
remote_root="$2"
case_name="$3"
devices="${4:-auto}"
duration="${5:-10}"
shift $(( $# >= 5 ? 5 : $# ))
application_command="${*:-}"
read -r -a ssh_opts <<< "${ASCEND_SSH_OPTS:-}"

ssh "${ssh_opts[@]}" "$target" 'bash -s' -- "$remote_root" "$case_name" "$devices" "$duration" "$application_command" <<'REMOTE'
set -euo pipefail

remote_root="$1"
case_name="$2"
devices="$3"
duration="$4"
application_command="${5:-}"

for env_file in \
  "$HOME/Ascend/ascend-toolkit/set_env.sh" \
  "$HOME/Ascend/ascend-toolkit/latest/set_env.sh" \
  "/usr/local/Ascend/cann-8.5.1/set_env.sh" \
  "/usr/local/Ascend/ascend-toolkit/set_env.sh" \
  "/usr/local/Ascend/ascend-toolkit/latest/set_env.sh"; do
  if [[ -f "$env_file" ]]; then
    # shellcheck disable=SC1090
    set +u
    source "$env_file"
    set -u
    break
  fi
done

if ! command -v msprof >/dev/null 2>&1; then
  echo "msprof not found after sourcing CANN environment" >&2
  exit 1
fi

mkdir -p "$remote_root"
run_id="$(date +%Y%m%d-%H%M%S)-$case_name"
run_dir="$remote_root/$run_id"
if [[ -e "$run_dir" ]]; then
  echo "Run directory already exists: $run_dir" >&2
  exit 1
fi
mkdir -p "$run_dir"

if [[ "$devices" == "auto" ]]; then
  npu_output="$(npu-smi info)"
  devices="$(
    NPU_SMI_OUTPUT="$npu_output" python3 - <<'PY'
import os
import re

text = os.environ["NPU_SMI_OUTPUT"]
devices = []
process_boards = set()
pending = None
in_proc = False
for raw in text.splitlines():
    line = raw.strip()
    if "Process id" in line and "Process memory" in line:
        in_proc = True
        continue
    if in_proc:
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) >= 4:
            ids = re.findall(r"\d+", cells[0])
            if ids:
                process_boards.add(ids[0])
        continue
    cells = [c.strip() for c in line.strip("|").split("|")]
    header = re.match(r"^\|\s*(\d+)\s+(Ascend\S+)\s*\|", raw)
    if header:
        pending = header.group(1)
        continue
    if pending is not None and len(cells) >= 2:
        ids = re.findall(r"\d+", cells[0])
        if len(ids) >= 2:
            devices.append((pending, ids[0], ids[1]))
        pending = None
free = [phy for board, _chip, phy in devices if board not in process_boards]
print(",".join(free[:1]))
PY
  )"
  if [[ -z "$devices" ]]; then
    echo "No free physical devices found for auto msprof capture" >&2
    exit 1
  fi
fi

{
  echo "run_id=$run_id"
  echo "host=$(hostname)"
  echo "date=$(date -Is || date)"
  echo "case_name=$case_name"
  echo "remote_root=$remote_root"
  echo "run_dir=$run_dir"
  echo "devices=$devices"
  echo "duration=$duration"
  echo "application_command=$application_command"
  echo "msprof=$(command -v msprof)"
} > "$run_dir/manifest.txt"

env | sort > "$run_dir/env.txt"
npu-smi info > "$run_dir/npu-smi-before.txt" 2>&1 || true

msprof_args=(
  "--output=$run_dir"
  "--sys-devices=$devices"
  "--sys-period=$duration"
  "--sys-profiling=on"
  "--sys-hardware-mem=on"
  "--type=text"
)

if [[ -n "$application_command" ]]; then
  cat > "$run_dir/application.sh" <<APP
#!/usr/bin/env bash
set -euo pipefail
bash -lc $(printf '%q' "$application_command")
APP
  chmod +x "$run_dir/application.sh"
  msprof_args+=(
    "--application=$run_dir/application.sh"
    "--runtime-api=on"
    "--task-time=on"
    "--ai-core=on"
    "--aic-metrics=PipeUtilization"
  )
fi

set +e
msprof "${msprof_args[@]}" > "$run_dir/msprof.stdout.log" 2> "$run_dir/msprof.stderr.log"
status=$?
set -e

npu-smi info > "$run_dir/npu-smi-after.txt" 2>&1 || true
echo "$status" > "$run_dir/exit_status.txt"
echo "$run_dir"
exit "$status"
REMOTE

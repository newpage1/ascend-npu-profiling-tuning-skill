#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 <ssh-target> [json|table]" >&2
  exit 2
fi

target="$1"
mode="${2:-table}"
read -r -a ssh_opts <<< "${ASCEND_SSH_OPTS:-}"

ssh "${ssh_opts[@]}" "$target" 'bash -s' -- "$mode" <<'REMOTE'
set -euo pipefail
mode="$1"

if ! command -v npu-smi >/dev/null 2>&1; then
  echo "npu-smi not found" >&2
  exit 1
fi

npu_output="$(npu-smi info)"

NPU_SMI_OUTPUT="$npu_output" python3 - "$mode" <<'PY'
import json
import os
import re
import sys

mode = sys.argv[1]
text = os.environ["NPU_SMI_OUTPUT"]

devices = []
processes = {}
in_process = False
pending = None

for raw in text.splitlines():
    line = raw.strip()
    if not line.startswith("|"):
        continue

    cells = [c.strip() for c in line.strip("|").split("|")]
    if "Process id" in line and "Process memory" in line:
        in_process = True
        continue
    if "No running processes found" in line:
        match = re.search(r"NPU\s+(\d+)", line)
        if match:
            processes.setdefault(match.group(1), [])
        continue
    if in_process and len(cells) >= 4:
        ids = re.findall(r"\d+", cells[0])
        if len(ids) < 2:
            continue
        proc = {
            "board_id": ids[0],
            "chip_id": ids[1],
            "pid": cells[1],
            "name": cells[2],
            "memory_mb": cells[3] if len(cells) > 3 else "",
        }
        processes.setdefault(ids[0], []).append(proc)
        continue

    header = re.match(r"^\|\s*(\d+)\s+(Ascend\S+)\s*\|", raw)
    if header:
        pending = {"board_id": header.group(1), "name": header.group(2)}
        continue

    if pending and len(cells) >= 3:
        ids = re.findall(r"\d+", cells[0])
        if len(ids) < 2:
            continue
        metric_numbers = re.findall(r"-?\d+", cells[2])
        device = dict(pending)
        device.update({
            "chip_id": ids[0],
            "phy_id": ids[1],
            "bus_id": cells[1],
            "aicore_pct": metric_numbers[0] if len(metric_numbers) > 0 else "",
            "memory_usage_mb": " / ".join(metric_numbers[1:3]) if len(metric_numbers) >= 3 else "",
            "hbm_usage_mb": " / ".join(metric_numbers[3:5]) if len(metric_numbers) >= 5 else "",
        })
        devices.append(device)
        pending = None

for device in devices:
    board_processes = processes.get(device["board_id"], [])
    chip_processes = [
        p for p in board_processes
        if p.get("chip_id") == device.get("chip_id") or len(board_processes) == 1
    ]
    device["processes"] = chip_processes
    device["free"] = len(chip_processes) == 0

free_phy_ids = [d["phy_id"] for d in devices if d["free"]]
result = {
    "devices": devices,
    "free_phy_ids": free_phy_ids,
    "busy_phy_ids": [d["phy_id"] for d in devices if not d["free"]],
}

if mode == "json":
    print(json.dumps(result, indent=2, sort_keys=True))
else:
    print("board chip phy bus aicore hbm_usage free processes")
    for d in devices:
        procs = ",".join(
            f'{p["pid"]}:{p["name"]}:{p.get("memory_mb", "")}'
            for p in d["processes"]
        )
        print(
            d.get("board_id", ""),
            d.get("chip_id", ""),
            d.get("phy_id", ""),
            d.get("bus_id", ""),
            d.get("aicore_pct", ""),
            d.get("hbm_usage_mb", ""),
            "yes" if d["free"] else "no",
            procs or "-",
            sep="\t",
        )
    print("free_phy_ids=" + ",".join(free_phy_ids))
PY
REMOTE

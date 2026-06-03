#!/usr/bin/env python3
import argparse
import csv
import json
from pathlib import Path
from statistics import mean


def read_csv(path):
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def first_match(root, pattern):
    matches = sorted(root.rglob(pattern))
    return matches[0] if matches else None


def to_float(value):
    if value is None:
        return None
    value = str(value).strip()
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def summarize(root):
    root = Path(root)
    output_dir = None
    for candidate in root.rglob("mindstudio_profiler_output"):
        output_dir = candidate
        break
    if output_dir is None:
        raise SystemExit(f"mindstudio_profiler_output not found under {root}")

    summary = {
        "artifact_root": str(root),
        "profiler_output": str(output_dir),
        "files": {},
        "resource_table": [],
        "bottleneck_overlap_table": [],
        "tuning_opportunity_table": [],
        "notes": [],
    }

    hbm_path = first_match(output_dir, "hbm_*.csv")
    npu_mem_path = first_match(output_dir, "npu_mem_*.csv")
    cpu_path = first_match(output_dir, "cpu_usage_*.csv")
    json_path = first_match(output_dir, "msprof_*.json")
    db_path = first_match(root, "msprof_*.db")

    for name, path in (
        ("hbm_csv", hbm_path),
        ("npu_mem_csv", npu_mem_path),
        ("cpu_usage_csv", cpu_path),
        ("timeline_json", json_path),
        ("database", db_path),
    ):
        if path:
            summary["files"][name] = str(path)

    resource = {}
    device_id = None

    if hbm_path:
        rows = read_csv(hbm_path)
        avg = next((r for r in rows if r.get("Metric") == "Average"), None)
        if avg:
            device_id = avg.get("Device_id") or device_id
            resource["hbm_read_mb_s_avg"] = to_float(avg.get("Read(MB/s)"))
            resource["hbm_write_mb_s_avg"] = to_float(avg.get("Write(MB/s)"))

    if npu_mem_path:
        rows = read_csv(npu_mem_path)
        mem_values = [to_float(r.get("memory(KB)")) for r in rows]
        mem_values = [v for v in mem_values if v is not None]
        if rows and not device_id:
            device_id = rows[0].get("Device_id")
        if mem_values:
            resource["npu_memory_mb_avg"] = round(mean(mem_values) / 1024, 3)
            resource["npu_memory_mb_max"] = round(max(mem_values) / 1024, 3)

    if cpu_path:
        rows = read_csv(cpu_path)
        for cpu_type in ("aicpu", "ctrlcpu"):
            row = next((r for r in rows if r.get("Cpu Type") == cpu_type), None)
            if row:
                resource[f"{cpu_type}_idle_pct"] = to_float(row.get("Idle(%)"))
                resource[f"{cpu_type}_user_pct"] = to_float(row.get("User(%)"))
                resource[f"{cpu_type}_sys_pct"] = to_float(row.get("Sys(%)"))

    if device_id is not None:
        resource["device_id"] = device_id

    summary["resource_table"].append(resource)

    if json_path:
        summary["bottleneck_overlap_table"].append({
            "scope": "timeline",
            "evidence": str(json_path),
            "finding": "Timeline JSON exported. Use MindStudio Insight or trace parser for host/device gaps and communication overlap.",
            "confidence": "medium",
        })
    else:
        summary["bottleneck_overlap_table"].append({
            "scope": "timeline",
            "evidence": "N/A",
            "finding": "No msprof timeline JSON was exported in this run.",
            "confidence": "low",
        })

    if resource.get("hbm_read_mb_s_avg") is not None:
        read = resource["hbm_read_mb_s_avg"]
        write = resource.get("hbm_write_mb_s_avg", 0) or 0
        if read + write < 100:
            opportunity = "This smoke/system window shows very low HBM bandwidth; it is not evidence of an operator memory bottleneck."
        else:
            opportunity = "HBM traffic is visible; compare against benchmark throughput and operator timeline before tuning layout or dtype."
        summary["tuning_opportunity_table"].append({
            "hypothesis": "memory_bandwidth",
            "evidence": f"HBM avg read={read} MB/s write={write} MB/s",
            "change": "Only tune memory layout/tiling if an application profile confirms the same bottleneck.",
            "validation": "Re-run benchmark and msprof with the workload active.",
        })
        summary["notes"].append(opportunity)

    if not summary["tuning_opportunity_table"]:
        summary["tuning_opportunity_table"].append({
            "hypothesis": "insufficient_evidence",
            "evidence": "Only partial or empty msprof outputs were found.",
            "change": "Capture an application or torch_npu profile with active workload.",
            "validation": "Repeat summary generation after capture.",
        })

    return summary


def markdown_table(rows):
    if not rows:
        return "N/A\n"
    keys = []
    for row in rows:
        for key in row:
            if key not in keys:
                keys.append(key)
    lines = [
        "| " + " | ".join(keys) + " |",
        "| " + " | ".join(["---"] * len(keys)) + " |",
    ]
    for row in rows:
        lines.append("| " + " | ".join(str(row.get(k, "")) for k in keys) + " |")
    return "\n".join(lines) + "\n"


def write_outputs(summary, root):
    root = Path(root)
    summary_json = root / "summary.json"
    summary_md = root / "summary.md"
    summary_json.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    summary_md.write_text(
        "# Ascend msprof Summary\n\n"
        "## Resource Table\n\n"
        + markdown_table(summary["resource_table"])
        + "\n## Bottleneck/Overlap Table\n\n"
        + markdown_table(summary["bottleneck_overlap_table"])
        + "\n## Tuning Opportunity Table\n\n"
        + markdown_table(summary["tuning_opportunity_table"])
        + "\n## Notes\n\n"
        + "\n".join(f"- {note}" for note in summary["notes"])
        + "\n"
    )
    return summary_json, summary_md


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact_root")
    parser.add_argument("--print-json", action="store_true")
    args = parser.parse_args()
    summary = summarize(args.artifact_root)
    summary_json, summary_md = write_outputs(summary, args.artifact_root)
    if args.print_json:
        print(json.dumps(summary, indent=2, sort_keys=True))
    else:
        print(summary_json)
        print(summary_md)


if __name__ == "__main__":
    main()

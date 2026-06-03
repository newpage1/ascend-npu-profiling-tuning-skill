#!/usr/bin/env python3
import argparse
import json
from pathlib import Path


FIELDS = [
    "hbm_read_mb_s_avg",
    "hbm_write_mb_s_avg",
    "npu_memory_mb_avg",
    "npu_memory_mb_max",
    "aicpu_idle_pct",
    "ctrlcpu_idle_pct",
]


def load(path):
    with Path(path).open() as handle:
        data = json.load(handle)
    rows = data.get("resource_table") or [{}]
    return rows[0]


def delta(before, after, key):
    b = before.get(key)
    a = after.get(key)
    if b is None or a is None:
        return None
    return a - b


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("before_summary_json")
    parser.add_argument("after_summary_json")
    parser.add_argument("--output")
    args = parser.parse_args()

    before = load(args.before_summary_json)
    after = load(args.after_summary_json)

    lines = [
        "# Ascend msprof Before/After Comparison",
        "",
        "| metric | before | after | delta |",
        "| --- | ---: | ---: | ---: |",
    ]
    result = []
    for key in FIELDS:
        d = delta(before, after, key)
        row = {
            "metric": key,
            "before": before.get(key),
            "after": after.get(key),
            "delta": d,
        }
        result.append(row)
        lines.append(
            f"| {key} | {row['before']} | {row['after']} | {'' if d is None else round(d, 3)} |"
        )

    payload = {
        "before": args.before_summary_json,
        "after": args.after_summary_json,
        "metrics": result,
    }
    text = "\n".join(lines) + "\n"
    if args.output:
        out = Path(args.output)
        out.write_text(text)
        json_out = out.with_suffix(".json")
        json_out.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
        print(out)
        print(json_out)
    else:
        print(text)


if __name__ == "__main__":
    main()

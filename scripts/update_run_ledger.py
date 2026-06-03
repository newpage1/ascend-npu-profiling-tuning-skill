#!/usr/bin/env python3
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


def load_summary(path):
    with Path(path).open() as handle:
        return json.load(handle)


def append_record(args):
    ledger = Path(args.ledger)
    ledger.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "run_id": args.run_id,
        "case": args.case,
        "kind": args.kind,
        "status": args.status,
        "remote_path": args.remote_path,
        "local_path": args.local_path,
        "command": args.command,
        "hypothesis": args.hypothesis,
        "change": args.change,
        "result": args.result,
    }
    if args.summary_json:
        record["summary"] = load_summary(args.summary_json)
    with ledger.open("a") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")
    return record


def read_records(ledger):
    path = Path(ledger)
    if not path.exists():
        return []
    records = []
    with path.open() as handle:
        for line in handle:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def render_markdown(args):
    records = read_records(args.ledger)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# Ascend Profiling Run Ledger",
        "",
        "| run_id | case | kind | status | result | local_path |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for record in records:
        lines.append(
            "| {run_id} | {case} | {kind} | {status} | {result} | {local_path} |".format(
                run_id=record.get("run_id", ""),
                case=record.get("case", ""),
                kind=record.get("kind", ""),
                status=record.get("status", ""),
                result=str(record.get("result", "")).replace("|", "/"),
                local_path=record.get("local_path", ""),
            )
        )
    output.write_text("\n".join(lines) + "\n")
    return output


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    append = sub.add_parser("append")
    append.add_argument("--ledger", required=True)
    append.add_argument("--run-id", required=True)
    append.add_argument("--case", default="")
    append.add_argument("--kind", default="profile")
    append.add_argument("--status", default="ok")
    append.add_argument("--remote-path", default="")
    append.add_argument("--local-path", default="")
    append.add_argument("--command", default="")
    append.add_argument("--hypothesis", default="")
    append.add_argument("--change", default="")
    append.add_argument("--result", default="")
    append.add_argument("--summary-json")

    render = sub.add_parser("render")
    render.add_argument("--ledger", required=True)
    render.add_argument("--output", required=True)

    args = parser.parse_args()
    if args.cmd == "append":
        record = append_record(args)
        print(json.dumps(record, indent=2, sort_keys=True))
    elif args.cmd == "render":
        print(render_markdown(args))


if __name__ == "__main__":
    main()

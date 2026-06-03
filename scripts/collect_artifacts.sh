#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 <ssh-target> <remote-run-dir> <local-dir>" >&2
  exit 2
fi

target="$1"
remote_run_dir="$2"
local_dir="$3"
ssh_opts="${ASCEND_SSH_OPTS:-}"

mkdir -p "$local_dir"

if command -v rsync >/dev/null 2>&1; then
  if [[ -n "$ssh_opts" ]]; then
    rsync -avz --partial -e "ssh $ssh_opts" "$target:$remote_run_dir/" "$local_dir/"
  else
    rsync -avz --partial "$target:$remote_run_dir/" "$local_dir/"
  fi
else
  tmp_archive="${local_dir%/}/remote-run.tar.gz"
  read -r -a ssh_opts_array <<< "$ssh_opts"
  ssh "${ssh_opts_array[@]}" "$target" "tar -C \"$(dirname "$remote_run_dir")\" -czf - \"$(basename "$remote_run_dir")\"" > "$tmp_archive"
  tar -C "$local_dir" --strip-components=1 -xzf "$tmp_archive"
fi

echo "$local_dir"

#!/bin/zsh

set -e

script_dir=${0:A:h}
cd "$script_dir"

export CODEX_TASKBOARD_HOST=127.0.0.1
exec npm run codex

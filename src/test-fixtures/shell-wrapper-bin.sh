#!/bin/sh

printf '%s\n' "$*" >>"${WORKFOREST_FAKE_LOG:?}"

if [ -n "${WORKFOREST_FAKE_CD_TARGET:-}" ]; then
  printf '%s\n' "$WORKFOREST_FAKE_CD_TARGET" >"${WORKFOREST_CD_PATH_FILE:?}"
fi

exit "${WORKFOREST_FAKE_EXIT_CODE:-0}"

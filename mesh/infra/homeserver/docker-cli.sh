#!/bin/sh

# Docker Desktop is a native Windows process. When it is invoked from
# Git Bash/MSYS, automatic argument conversion rewrites container paths such
# as /data and bind-mount sources need an explicit Windows representation.
# Keep that compatibility detail at the Docker boundary so the operational
# scripts otherwise remain portable POSIX shell.
case "$(uname -s 2>/dev/null || printf unknown)" in
  MINGW*|MSYS*|CYGWIN*) mesh_docker_msys=1 ;;
  *) mesh_docker_msys=0 ;;
esac

mesh_docker_bind_path() {
  if [ "$mesh_docker_msys" -eq 1 ]; then
    cygpath -am -- "$1"
  else
    printf '%s\n' "$1"
  fi
}

mesh_docker() {
  if [ "$mesh_docker_msys" -eq 1 ]; then
    MSYS_NO_PATHCONV=1 command docker "$@"
  else
    command docker "$@"
  fi
}

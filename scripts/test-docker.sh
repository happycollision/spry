#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Source docker/.env if it exists (for GH_TOKEN, used when recording cassettes)
if [ -f "$PROJECT_DIR/docker/.env" ]; then
    set -a
    source "$PROJECT_DIR/docker/.env"
    set +a
fi

usage() {
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Run the test suite in Docker against a supported git version."
    echo "The local git here is too old to run tests directly, so this is the"
    echo "canonical way to run them."
    echo ""
    echo "The suite is offline by default: doc tests replay committed gh cassettes"
    echo "(tests/fixtures/cassettes). To RE-RECORD a cassette against real GitHub,"
    echo "run bun directly with SPRY_RECORD=1 — see tests/fixtures/cassettes/README.md."
    echo ""
    echo "Commands:"
    echo "  shell [2.40|2.38]    Start an interactive shell (default git 2.40)"
    echo "  test [files...]      Run the full suite (git 2.40), or specific files/globs"
    echo ""
    echo "Examples:"
    echo "  $0 test                              # full suite"
    echo "  $0 test tests/commands/sync.doc.test.ts   # one file"
    echo "  $0 shell                             # dev shell, git 2.40"
    echo "  $0 shell 2.38                        # dev shell, git 2.38 (unsupported, for manual repro)"
}

get_service() {
    case "${1:-2.40}" in
        2.40) echo "dev" ;;
        2.38) echo "dev-old-git" ;;
        *) echo "Unknown version: $1" >&2; exit 1 ;;
    esac
}

shell_cmd() {
    local service=$(get_service "$1")
    cd "$PROJECT_DIR/docker"
    docker compose run --rm "$service"
}

run_docker_test() {
    local service="$1"
    local test_cmd="$2"
    cd "$PROJECT_DIR/docker"
    docker compose run --rm "$service" bash -c "git --version && bun install --frozen-lockfile && $test_cmd"
}

test_cmd() {
    local extra_args="$*"
    local test_cmd="bun test"
    if [ -n "$extra_args" ]; then
        test_cmd="bun test $extra_args"
    fi
    run_docker_test "dev" "$test_cmd"
}

case "${1:-help}" in
    shell)
        shell_cmd "$2"
        ;;
    test)
        shift
        test_cmd "$@"
        ;;
    -h|--help|help)
        usage
        ;;
    *)
        echo "Unknown command: $1"
        usage
        exit 1
        ;;
esac

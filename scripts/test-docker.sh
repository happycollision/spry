#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

usage() {
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Run tests or develop in Docker with specific git versions."
    echo ""
    echo "Commands:"
    echo "  shell [2.40|2.38]    Start interactive shell (default: 2.40)"
    echo "  test [2.40|2.38]     Run tests and exit (default: 2.40)"
    echo "  test-all             Run both test suites (2.40 full, 2.38 version only)"
    echo ""
    echo "Examples:"
    echo "  $0 shell             # Dev shell with git 2.40"
    echo "  $0 shell 2.38        # Dev shell with git 2.38"
    echo "  $0 test              # Run all tests with git 2.40"
    echo "  $0 test 2.38         # Run version tests with git 2.38"
    echo "  $0 test-all          # Run both CI test suites"
}

get_version() {
    case "${1:-2.40}" in
        2.40) echo "2.40.0" ;;
        2.38) echo "2.38.5" ;;
        *) echo "Unknown version: $1" >&2; exit 1 ;;
    esac
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

test_cmd() {
    local version="${1:-2.40}"
    local service=$(get_service "$version")
    local test_cmd="bun test"

    # Only run version tests for old git
    if [ "$version" = "2.38" ]; then
        test_cmd="bun test tests/git-version.test.ts"
    fi

    cd "$PROJECT_DIR/docker"
    docker compose run --rm "$service" bash -c "git --version && bun install --frozen-lockfile && $test_cmd"
}

test_all_cmd() {
    echo "=========================================="
    echo "Running all tests with git 2.40.0"
    echo "=========================================="
    test_cmd 2.40

    echo ""
    echo "=========================================="
    echo "Running version tests with git 2.38.5"
    echo "=========================================="
    test_cmd 2.38

    echo ""
    echo "=========================================="
    echo "All tests passed!"
    echo "=========================================="
}

case "${1:-help}" in
    shell)
        shell_cmd "$2"
        ;;
    test)
        test_cmd "$2"
        ;;
    test-all)
        test_all_cmd
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

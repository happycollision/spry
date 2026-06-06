#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Source docker/.env if it exists (for GH_TOKEN)
if [ -f "$PROJECT_DIR/docker/.env" ]; then
    set -a
    source "$PROJECT_DIR/docker/.env"
    set +a
fi

usage() {
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Run tests or develop in Docker with specific git versions."
    echo ""
    echo "Commands:"
    echo "  shell [2.40|2.38]    Start interactive shell (default: 2.40)"
    echo "  test [2.40|2.38] [files...]  Run all unit tests (default: 2.40), or specific files/globs"
    echo "  test-all             Run both test suites (2.40 full, 2.38 version only)"
    echo "  test-local           Run integration tests (local only, no GitHub)"
    echo "  test-github          Run integration tests with GitHub API"
    echo "  test-ci              Run integration tests with GitHub API + CI"
    echo "  test-unsupported     Run version tests with git 2.38 (unsupported)"
    echo ""
    echo "Examples:"
    echo "  $0 shell             # Dev shell with git 2.40"
    echo "  $0 shell 2.38        # Dev shell with git 2.38"
    echo "  $0 test              # Run all unit tests with git 2.40"
    echo "  $0 test-local        # Run local integration tests"
    echo "  $0 test-github       # Run GitHub integration tests"
    echo "  $0 test-ci           # Run full integration tests (GitHub + CI)"
    echo "  $0 test-unsupported  # Run version tests with git 2.38"
    echo "  $0 test-all          # Run both CI test suites"
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
    local version="2.40"
    local extra_args=""

    # If first arg looks like a version number, consume it; otherwise treat all args as bun test args
    if [ "${1:-}" = "2.40" ] || [ "${1:-}" = "2.38" ]; then
        version="$1"
        shift
    fi
    extra_args="$*"

    local service=$(get_service "$version")
    local test_cmd="bun test"

    # Only run version tests for old git
    if [ "$version" = "2.38" ]; then
        test_cmd="bun test tests/git-version.test.ts"
    elif [ -n "$extra_args" ]; then
        test_cmd="bun test $extra_args"
    fi

    run_docker_test "$service" "$test_cmd"
}

test_local_cmd() {
    run_docker_test "dev" "bun test tests/integration/"
}

test_github_cmd() {
    # Use --max-concurrency=1 to prevent test files from running in parallel
    # since they all share the same GitHub test repo (happycollision/spry-check)
    run_docker_test "dev" "GITHUB_INTEGRATION_TESTS=1 bun test tests/integration/ --max-concurrency=1"
}

test_ci_cmd() {
    # Use --max-concurrency=1 to prevent test files from running in parallel
    # since they all share the same GitHub test repo (happycollision/spry-check)
    run_docker_test "dev" "GITHUB_INTEGRATION_TESTS=1 GITHUB_CI_TESTS=1 bun test tests/integration/ --max-concurrency=1"
}

test_unsupported_cmd() {
    run_docker_test "dev-old-git" "bun test tests/git-version.test.ts"
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
    test_unsupported_cmd

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
        shift
        test_cmd "$@"
        ;;
    test-local)
        test_local_cmd
        ;;
    test-github)
        test_github_cmd
        ;;
    test-ci)
        test_ci_cmd
        ;;
    test-unsupported)
        test_unsupported_cmd
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

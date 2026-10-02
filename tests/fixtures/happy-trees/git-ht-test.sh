#!/bin/sh
# Test suite for git-ht (v2 API)
# Run from the dotfiles repository root

set -e

# --- Hermetic git environment --------------------------------------------
# This suite creates bare repos and cd's into them (the "bare" test passes).
# Some environments inject `safe.bareRepository=explicit` via git's
# GIT_CONFIG_COUNT/GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n env mechanism (or set it
# in global/system config), which makes a plain `git` command refuse to operate
# on a bare repo discovered from the CWD ("fatal: not in a git directory") and
# breaks setup. Neutralize that injection and force bare-repo access on for our
# own git invocations so the suite is not at the mercy of the caller's config.
if [ -n "${GIT_CONFIG_COUNT:-}" ]; then
  i=0
  while [ "$i" -lt "$GIT_CONFIG_COUNT" ]; do
    unset "GIT_CONFIG_KEY_$i" "GIT_CONFIG_VALUE_$i"
    i=$((i + 1))
  done
  unset GIT_CONFIG_COUNT
fi
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=safe.bareRepository
export GIT_CONFIG_VALUE_0=all
# -------------------------------------------------------------------------

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Get the absolute path to the script's directory (test/)
# and derive the dotfiles root from there
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
DOTFILES_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
SANDBOX="$DOTFILES_ROOT/tmp"
GIT_HT_PATH="$DOTFILES_ROOT/bin/git-ht"
TEST_REPO_DIR="$SANDBOX/test-repo"

# Test helper functions
assert_success() {
  TESTS_RUN=$((TESTS_RUN + 1))
  if eval "$1" >/dev/null 2>&1; then
    TESTS_PASSED=$((TESTS_PASSED + 1))
    printf "${GREEN}✓${NC} %s\n" "$2"
    return 0
  else
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "${RED}✗${NC} %s\n" "$2"
    return 1
  fi
}

assert_failure() {
  TESTS_RUN=$((TESTS_RUN + 1))
  if ! eval "$1" >/dev/null 2>&1; then
    TESTS_PASSED=$((TESTS_PASSED + 1))
    printf "${GREEN}✓${NC} %s\n" "$2"
    return 0
  else
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "${RED}✗${NC} %s\n" "$2"
    return 1
  fi
}

assert_output_contains() {
  TESTS_RUN=$((TESTS_RUN + 1))
  output=$(eval "$1" 2>&1 || true)
  if echo "$output" | grep -q "$2"; then
    TESTS_PASSED=$((TESTS_PASSED + 1))
    printf "${GREEN}✓${NC} %s\n" "$3"
    return 0
  else
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "${RED}✗${NC} %s\n" "$3"
    printf "  Expected output to contain: %s\n" "$2"
    printf "  Actual output: %s\n" "$output"
    return 1
  fi
}

assert_file_exists() {
  TESTS_RUN=$((TESTS_RUN + 1))
  if [ -e "$1" ]; then
    TESTS_PASSED=$((TESTS_PASSED + 1))
    printf "${GREEN}✓${NC} %s\n" "$2"
    return 0
  else
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "${RED}✗${NC} %s\n" "$2"
    return 1
  fi
}

assert_file_not_exists() {
  TESTS_RUN=$((TESTS_RUN + 1))
  if [ ! -e "$1" ]; then
    TESTS_PASSED=$((TESTS_PASSED + 1))
    printf "${GREEN}✓${NC} %s\n" "$2"
    return 0
  else
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "${RED}✗${NC} %s\n" "$2"
    return 1
  fi
}

# Setup test repository
# Usage: setup_test_repo <mode>
#   normal         - non-bare repo with remote
#   bare           - bare local clone with remote (worktree-only workflow)
#   normal-noremote - non-bare repo with no remote
#   bare-noremote  - bare repo with no remote
setup_test_repo() {
  local mode="${1:-normal}"
  HAS_REMOTE=1
  printf "${YELLOW}Setting up test repository (mode: %s)...${NC}\n" "$mode"

  # Remove any existing sandbox
  rm -rf "$SANDBOX"

  case "$mode" in
    normal)
      # Create bare origin repo
      mkdir -p "$SANDBOX/origin.git"
      git init -q --bare "$SANDBOX/origin.git"

      # Create test repo directory
      mkdir -p "$TEST_REPO_DIR"
      cd "$TEST_REPO_DIR"

      # Initialize git repo
      git init -q
      git config user.name "Test User"
      git config user.email "test@example.com"

      # Create initial commit
      echo "# Test Repository" > README.md
      git add README.md
      git commit -q -m "Initial commit"

      # Create a few more commits for testing HEAD~N
      echo "Content 1" > file1.txt
      git add file1.txt
      git commit -q -m "Add file1"

      echo "Content 2" > file2.txt
      git add file2.txt
      git commit -q -m "Add file2"

      # Set up default branch as master
      git branch -M master

      # Add the bare repo as origin and push
      git remote add origin "$SANDBOX/origin.git"
      git push -q -u origin master
      ;;

    bare)
      # Create bare origin repo and seed it
      mkdir -p "$SANDBOX/origin.git"
      git init -q --bare "$SANDBOX/origin.git"

      local seed_dir="$SANDBOX/seed-repo"
      mkdir -p "$seed_dir"
      cd "$seed_dir"
      git init -q
      git config user.name "Test User"
      git config user.email "test@example.com"
      echo "# Test Repository" > README.md
      git add README.md
      git commit -q -m "Initial commit"
      echo "Content 1" > file1.txt
      git add file1.txt
      git commit -q -m "Add file1"
      echo "Content 2" > file2.txt
      git add file2.txt
      git commit -q -m "Add file2"
      git branch -M master
      git remote add origin "$SANDBOX/origin.git"
      git push -q -u origin master
      cd "$SANDBOX"
      rm -rf "$seed_dir"

      # Bare clone from origin
      git clone -q --bare "$SANDBOX/origin.git" "$TEST_REPO_DIR"
      cd "$TEST_REPO_DIR"
      git config user.name "Test User"
      git config user.email "test@example.com"
      ;;

    normal-noremote)
      HAS_REMOTE=0

      mkdir -p "$TEST_REPO_DIR"
      cd "$TEST_REPO_DIR"

      git init -q
      git config user.name "Test User"
      git config user.email "test@example.com"

      echo "# Test Repository" > README.md
      git add README.md
      git commit -q -m "Initial commit"

      echo "Content 1" > file1.txt
      git add file1.txt
      git commit -q -m "Add file1"

      echo "Content 2" > file2.txt
      git add file2.txt
      git commit -q -m "Add file2"

      git branch -M master
      ;;

    bare-noremote)
      HAS_REMOTE=0

      # Need a seed repo to create the bare repo from
      local seed_dir="$SANDBOX/seed-repo"
      mkdir -p "$seed_dir"
      cd "$seed_dir"
      git init -q
      git config user.name "Test User"
      git config user.email "test@example.com"
      echo "# Test Repository" > README.md
      git add README.md
      git commit -q -m "Initial commit"
      echo "Content 1" > file1.txt
      git add file1.txt
      git commit -q -m "Add file1"
      echo "Content 2" > file2.txt
      git add file2.txt
      git commit -q -m "Add file2"
      git branch -M master
      cd "$SANDBOX"

      # Create bare repo by cloning seed (gives us proper refs)
      git clone -q --bare "$seed_dir" "$TEST_REPO_DIR"
      rm -rf "$seed_dir"
      cd "$TEST_REPO_DIR"
      git config user.name "Test User"
      git config user.email "test@example.com"
      # Remove the origin that clone created
      git remote remove origin
      ;;
  esac

  # Set worktreesDir explicitly to avoid path resolution issues with ../
  git config happy-trees.worktreesDir "$SANDBOX/test-repo.worktrees"

  # Override global exec config (e.g. "code") so no editor opens during tests
  git config happy-trees.exec ""

  printf "${GREEN}Test repository created at: %s${NC}\n\n" "$TEST_REPO_DIR"
}

# Cleanup function
cleanup() {
  printf "\n${YELLOW}Cleaning up...${NC}\n"

  # Return to dotfiles root
  cd "$DOTFILES_ROOT"

  # Remove entire sandbox directory (test repo and all worktrees)
  rm -rf "$SANDBOX"

  printf "${GREEN}Cleanup complete${NC}\n\n"
}

# Wrapper to call git-ht from test repo
git_ht() {
  "$GIT_HT_PATH" "$@"
}

# Trap to ensure cleanup runs on exit
trap cleanup EXIT INT TERM

# ============================================================================
# Run all tests against the current test repo
# Usage: run_all_tests
# ============================================================================
run_all_tests() {

  # ============================================================================
  # Test Group 1: Help and Basic Commands
  # ============================================================================
  printf "${YELLOW}Test Group: Help and Basic Commands${NC}\n"
  assert_output_contains "git_ht --help" "Usage: git ht" "git ht --help shows usage information"
  assert_output_contains "git_ht -h" "Usage: git ht" "git ht -h shows usage information"
  assert_output_contains "git_ht" "Usage: git ht" "git ht without args shows help"
  assert_output_contains "git_ht help" "Usage: git ht" "git ht help shows usage information"
  assert_output_contains "git_ht --help" "checkout" "Help mentions checkout command"
  assert_output_contains "git_ht --help" "co" "Help mentions co alias"
  assert_output_contains "git_ht --help" "remove" "Help mentions remove command"
  assert_output_contains "git_ht --help" "destroy" "Help mentions destroy command"
  assert_output_contains "git_ht --help" "setup" "Help mentions setup command"
  assert_output_contains "git_ht bogus-command" "Unknown subcommand" "Unknown subcommand shows error"
  assert_output_contains "git_ht --help" "list" "Help mentions list command"
  assert_output_contains "git_ht --help" "ls" "Help mentions ls alias"

  # ============================================================================
  # Test Group: List
  # ============================================================================
  printf "\n${YELLOW}Test Group: List${NC}\n"

  # No linked worktrees yet
  assert_output_contains "git_ht list" "No linked worktrees" "list with no worktrees shows message"

  # Create a worktree and verify it shows up
  assert_success "git_ht co list-test-1" "Create worktree for list test"
  assert_output_contains "git_ht list" "list-test-1" "list shows the created worktree"

  # Verify no warning for properly named worktree
  list_output=$(git_ht list 2>&1)
  if echo "$list_output" | grep -q "list-test-1" && ! echo "$list_output" | grep "list-test-1" | grep -q "!"; then
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_PASSED=$((TESTS_PASSED + 1))
    printf "${GREEN}✓${NC} Properly named worktree has no warning\n"
  else
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "${RED}✗${NC} Properly named worktree has no warning\n"
    printf "  Output: %s\n" "$list_output"
  fi

  # A worktree whose final path segment does NOT match its branch name is
  # flagged (git checkout was likely run inside it). Location is irrelevant —
  # this one lives outside worktreesDir but is flagged because the path
  # ("wrong-path") does not reflect the branch ("list-mismatch-branch").
  mkdir -p "$SANDBOX/other-location"
  git worktree add "$SANDBOX/other-location/wrong-path" -b list-mismatch-branch
  assert_output_contains "git_ht list" "path does not match branch" "list flags worktree whose path does not reflect its branch"
  assert_output_contains "git_ht list" "list-mismatch-branch" "list shows mismatched worktree branch name"

  # A worktree at a CUSTOM location whose final path segment DOES match its
  # branch name must NOT be flagged. This is the behavior the location-gate
  # removal is all about.
  git worktree add "$SANDBOX/other-location/custom-ok" -b custom-ok
  list_ok_output=$(git_ht list 2>&1)
  if echo "$list_ok_output" | grep -q "custom-ok" && ! echo "$list_ok_output" | grep "custom-ok" | grep -q "!"; then
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_PASSED=$((TESTS_PASSED + 1))
    printf "${GREEN}✓${NC} Off-location worktree with matching name is not flagged\n"
  else
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "${RED}✗${NC} Off-location worktree with matching name is not flagged\n"
    printf "  Output: %s\n" "$list_ok_output"
  fi

  # Create a detached HEAD worktree
  git worktree add --detach "$SANDBOX/other-location/detached-wt" HEAD
  assert_output_contains "git_ht list" "detached" "list shows detached HEAD worktree"
  assert_output_contains "git_ht list" "no branch" "list flags detached worktree with no branch warning"

  # ls alias works
  assert_output_contains "git_ht ls" "list-test-1" "ls alias works"

  # Clean up worktrees for subsequent tests
  git worktree remove "$SANDBOX/other-location/wrong-path"
  git worktree remove "$SANDBOX/other-location/custom-ok"
  git worktree remove "$SANDBOX/other-location/detached-wt"
  git branch -D list-mismatch-branch 2>/dev/null || true
  git branch -D custom-ok 2>/dev/null || true
  git_ht remove list-test-1 --force 2>/dev/null || true

  # ============================================================================
  # Test Group: Interactive selector entry building (no fzf)
  # ============================================================================
  printf "\n${YELLOW}Test Group: Interactive Selector Entries${NC}\n"

  # The interactive selectors (git ht co / remove / destroy without a branch
  # arg) build a newline-separated list of entries to pipe into fzf. Each entry
  # MUST be on its own line, otherwise fzf renders everything as a single line.
  # These helpers are exercised directly so we don't need an interactive TTY.

  # Create a couple of worktrees plus a non-worktree branch so each selector has
  # multiple entries to render.
  git_ht co iface-wt-1 >/dev/null 2>&1
  git_ht co iface-wt-2 >/dev/null 2>&1
  git branch iface-plain-branch >/dev/null 2>&1

  # --- checkout selector ---
  # The two worktrees must appear as two SEPARATE lines tagged "(worktree)".
  # The original bug collapsed them (and every other entry) onto one line
  # because the per-entry newline was stripped by command substitution. We
  # assert on the worktree count specifically so the test fails even if only
  # the worktree-entry path regresses.
  co_entries=$(GIT_HT_DUMP=checkout-entries "$GIT_HT_PATH" co 2>/dev/null)
  co_wt_lines=$(printf '%s\n' "$co_entries" | grep -c '(worktree)$' || true)
  if [ "$co_wt_lines" -eq 2 ]; then
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_PASSED=$((TESTS_PASSED + 1))
    printf "${GREEN}✓${NC} Checkout selector renders each worktree on its own line\n"
  else
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "${RED}✗${NC} Checkout selector: expected 2 worktree lines, got %s\n" "$co_wt_lines"
    printf "  Entries: %s\n" "$co_entries"
  fi

  # --- worktree selector (remove/destroy) ---
  # Both worktrees must appear on their own line.
  wt_entries=$(GIT_HT_DUMP=worktree-entries "$GIT_HT_PATH" remove 2>/dev/null)
  wt_lines=$(printf '%s\n' "$wt_entries" | grep -c '^iface-wt-' || true)
  if [ "$wt_lines" -eq 2 ]; then
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_PASSED=$((TESTS_PASSED + 1))
    printf "${GREEN}✓${NC} Worktree selector renders each worktree on its own line\n"
  else
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "${RED}✗${NC} Worktree selector: expected 2 worktree lines, got %s\n" "$wt_lines"
    printf "  Entries: %s\n" "$wt_entries"
  fi

  # Cleanup
  git_ht remove iface-wt-1 --force >/dev/null 2>&1 || true
  git_ht remove iface-wt-2 --force >/dev/null 2>&1 || true
  git branch -D iface-wt-1 iface-wt-2 iface-plain-branch 2>/dev/null || true

  # ============================================================================
  # Test Group 2: Checkout - new branch
  # ============================================================================
  printf "\n${YELLOW}Test Group: Checkout - New Branch${NC}\n"
  assert_success "git_ht co new-branch-1" "Creates worktree with new branch from default"
  assert_file_exists "$SANDBOX/test-repo.worktrees/new-branch-1" "Worktree directory exists in correct location"
  assert_success "git worktree list | grep -q new-branch-1" "Worktree appears in git worktree list"
  assert_success "git branch --list new-branch-1 | grep -q new-branch-1" "Branch was created"
  
  # Verify it was created from master (default branch)
  wt_head=$(git -C "$SANDBOX/test-repo.worktrees/new-branch-1" rev-parse HEAD)
  master_head=$(git rev-parse master)
  if [ "$wt_head" = "$master_head" ]; then
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_PASSED=$((TESTS_PASSED + 1))
    printf "${GREEN}✓${NC} New branch starts from default branch (master)\n"
  else
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "${RED}✗${NC} New branch does not start from default branch\n"
  fi
  
  # Also test using the full 'checkout' command name
  assert_success "git_ht checkout new-branch-full" "Creates worktree with 'checkout' (full name)"
  assert_file_exists "$SANDBOX/test-repo.worktrees/new-branch-full" "Worktree exists for full checkout command"
  git worktree remove "$SANDBOX/test-repo.worktrees/new-branch-full"
  git branch -D new-branch-full
  
  # ============================================================================
  # Test Group 3: Checkout - new branch with base
  # ============================================================================
  printf "\n${YELLOW}Test Group: Checkout - New Branch with Base${NC}\n"
  assert_success "git_ht co new-branch-base HEAD~1" "Creates worktree from specific ref"
  assert_file_exists "$SANDBOX/test-repo.worktrees/new-branch-base" "Worktree created from specific ref"
  
  # Verify it's at the right commit
  commit_hash=$(git -C "$SANDBOX/test-repo.worktrees/new-branch-base" rev-parse HEAD)
  expected_hash=$(git rev-parse HEAD~1)
  if [ "$commit_hash" = "$expected_hash" ]; then
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_PASSED=$((TESTS_PASSED + 1))
    printf "${GREEN}✓${NC} Worktree HEAD is at correct commit (HEAD~1)\n"
  else
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "${RED}✗${NC} Worktree HEAD is at wrong commit\n"
  fi
  
  # Cleanup
  git worktree remove "$SANDBOX/test-repo.worktrees/new-branch-base"
  git branch -D new-branch-base
  
  # ============================================================================
  # Test Group 4: Checkout - existing branch (auto-detected)
  # ============================================================================
  printf "\n${YELLOW}Test Group: Checkout - Existing Branch${NC}\n"
  
  # Create a branch without a worktree first
  git branch existing-branch HEAD~1
  
  assert_success "git_ht co existing-branch" "Creates worktree for existing branch (auto-detected)"
  assert_file_exists "$SANDBOX/test-repo.worktrees/existing-branch" "Worktree directory exists for existing branch"
  
  # Verify it's on the existing branch's commit (HEAD~1)
  existing_head=$(git -C "$SANDBOX/test-repo.worktrees/existing-branch" rev-parse HEAD)
  expected_existing=$(git rev-parse HEAD~1)
  if [ "$existing_head" = "$expected_existing" ]; then
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_PASSED=$((TESTS_PASSED + 1))
    printf "${GREEN}✓${NC} Worktree is on existing branch's commit\n"
  else
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "${RED}✗${NC} Worktree is not on existing branch's commit\n"
  fi
  
  # ============================================================================
  # Test Group 5: Checkout - existing worktree (already checked out)
  # ============================================================================
  printf "\n${YELLOW}Test Group: Checkout - Existing Worktree${NC}\n"
  
  # existing-branch already has a worktree from above
  assert_output_contains "git_ht co existing-branch" "already exists" "Reports worktree already exists"
  
  # ============================================================================
  # Test Group 6: Checkout - base arg errors
  # ============================================================================
  printf "\n${YELLOW}Test Group: Checkout - Base Arg Errors${NC}\n"
  
  # existing-branch already exists as a branch, so providing a base should error
  assert_output_contains "git_ht co existing-branch some-base" "not valid" "Errors when base given for existing branch with worktree"
  
  # Remove the worktree but keep the branch
  git worktree remove "$SANDBOX/test-repo.worktrees/existing-branch"
  
  # Try again without a worktree — branch still exists, base still invalid
  assert_output_contains "git_ht co existing-branch some-base" "not valid" "Errors when base given for existing branch without worktree"
  
  # Cleanup
  git branch -D existing-branch
  
  # ============================================================================
  # Test Group 7: Checkout - exec flag
  # ============================================================================
  printf "\n${YELLOW}Test Group: Checkout - Exec Flag${NC}\n"
  
  # Create a test script that writes pwd to a marker file when called
  mkdir -p "$SANDBOX/test-commands"
  cat > "$SANDBOX/test-commands/test-cmd" <<'TESTCMD'
  #!/bin/sh
  pwd > "$TEST_MARKER_FILE"
TESTCMD
  chmod +x "$SANDBOX/test-commands/test-cmd"
  
  export TEST_MARKER_FILE="$SANDBOX/exec-test-marker.txt"
  export PATH="$SANDBOX/test-commands:$PATH"
  
  # Test -e flag on new worktree creation
  rm -f "$TEST_MARKER_FILE"
  assert_success "git_ht co exec-test-1 -e test-cmd" "Creates worktree with -e test-cmd"
  assert_file_exists "$TEST_MARKER_FILE" "Exec command was executed (marker file exists)"
  
  # Verify exec ran from the worktree directory
  if [ -f "$TEST_MARKER_FILE" ]; then
    received_path=$(cat "$TEST_MARKER_FILE" | tr -d '[:space:]')
    expected_path=$(cd "$SANDBOX/test-repo.worktrees/exec-test-1" && pwd)
    if [ "$received_path" = "$expected_path" ]; then
      TESTS_RUN=$((TESTS_RUN + 1))
      TESTS_PASSED=$((TESTS_PASSED + 1))
      printf "${GREEN}✓${NC} Exec command ran from worktree directory\n"
    else
      TESTS_RUN=$((TESTS_RUN + 1))
      TESTS_FAILED=$((TESTS_FAILED + 1))
      printf "${RED}✗${NC} Exec command ran from wrong directory\n"
      printf "  Expected: %s\n" "$expected_path"
      printf "  Received: %s\n" "$received_path"
    fi
  fi
  
  # Test -e flag on existing worktree checkout (re-visit)
  rm -f "$TEST_MARKER_FILE"
  assert_success "git_ht co exec-test-1 -e test-cmd" "Re-checkout existing worktree with -e test-cmd"
  assert_file_exists "$TEST_MARKER_FILE" "Exec command ran on existing worktree checkout"
  
  # Test -E flag skips exec (even if -e is not provided, but config might be set)
  rm -f "$TEST_MARKER_FILE"
  assert_success "git_ht co exec-test-1 -E" "Re-checkout with -E skips exec"
  assert_file_not_exists "$TEST_MARKER_FILE" "No exec command ran with -E flag"
  
  # Test with long forms
  rm -f "$TEST_MARKER_FILE"
  assert_success "git_ht co exec-test-1 --exec test-cmd" "Re-checkout with --exec (long form)"
  assert_file_exists "$TEST_MARKER_FILE" "Exec command ran with --exec long form"
  
  rm -f "$TEST_MARKER_FILE"
  assert_success "git_ht co exec-test-1 --no-exec" "Re-checkout with --no-exec (long form)"
  assert_file_not_exists "$TEST_MARKER_FILE" "No exec command ran with --no-exec long form"

  # Test multi-word exec command (e.g. "test-cmd .")
  rm -f "$TEST_MARKER_FILE"
  assert_success "git_ht co exec-test-1 -e 'test-cmd .'" "Re-checkout with multi-word exec command"
  assert_file_exists "$TEST_MARKER_FILE" "Multi-word exec command was executed"

  # Cleanup exec-test-1
  git worktree remove "$SANDBOX/test-repo.worktrees/exec-test-1"
  git branch -D exec-test-1
  
  # Test non-existent command (should warn but not fail)
  assert_output_contains "git_ht co exec-test-noexist -e nonexistent-command-xyz" "not found" "Warns when exec command not found"
  assert_file_exists "$SANDBOX/test-repo.worktrees/exec-test-noexist" "Worktree still created when exec command not found"
  git worktree remove "$SANDBOX/test-repo.worktrees/exec-test-noexist"
  git branch -D exec-test-noexist
  
  # Test failing command (should warn but not fail)
  cat > "$SANDBOX/test-commands/fail-cmd" <<'FAILCMD'
  #!/bin/sh
  exit 1
FAILCMD
  chmod +x "$SANDBOX/test-commands/fail-cmd"
  
  assert_output_contains "git_ht co exec-test-fail -e fail-cmd" "failed" "Warns when exec command fails"
  assert_file_exists "$SANDBOX/test-repo.worktrees/exec-test-fail" "Worktree still created when exec command fails"
  git worktree remove "$SANDBOX/test-repo.worktrees/exec-test-fail"
  git branch -D exec-test-fail
  
  rm -f "$TEST_MARKER_FILE"
  
  # ============================================================================
  # Test Group 8: Checkout - exec config default
  # ============================================================================
  printf "\n${YELLOW}Test Group: Checkout - Exec Config Default${NC}\n"
  
  git config happy-trees.exec test-cmd
  
  # Test that config default is used on create
  rm -f "$TEST_MARKER_FILE"
  assert_success "git_ht co exec-config-1" "Creates worktree using default exec from config"
  assert_file_exists "$TEST_MARKER_FILE" "Default exec command was executed on create"
  
  # Test that config default is used on existing worktree checkout
  rm -f "$TEST_MARKER_FILE"
  assert_success "git_ht co exec-config-1" "Re-checkout triggers default exec"
  assert_file_exists "$TEST_MARKER_FILE" "Default exec command was executed on existing worktree"
  
  # Test that -E skips the config default
  rm -f "$TEST_MARKER_FILE"
  assert_success "git_ht co exec-config-1 -E" "Re-checkout with -E skips config default"
  assert_file_not_exists "$TEST_MARKER_FILE" "Config default exec skipped with -E"
  
  # Test that explicit -e overrides the config default
  rm -f "$TEST_MARKER_FILE"
  cat > "$SANDBOX/test-commands/other-cmd" <<'OTHERCMD'
  #!/bin/sh
  echo "other:$(pwd)" > "$TEST_MARKER_FILE"
OTHERCMD
  chmod +x "$SANDBOX/test-commands/other-cmd"
  
  assert_success "git_ht co exec-config-1 -e other-cmd" "Re-checkout with explicit -e overrides config"
  if [ -f "$TEST_MARKER_FILE" ]; then
    if grep -q "^other:" "$TEST_MARKER_FILE"; then
      TESTS_RUN=$((TESTS_RUN + 1))
      TESTS_PASSED=$((TESTS_PASSED + 1))
      printf "${GREEN}✓${NC} Explicit -e flag overrides config default\n"
    else
      TESTS_RUN=$((TESTS_RUN + 1))
      TESTS_FAILED=$((TESTS_FAILED + 1))
      printf "${RED}✗${NC} Config default was used instead of explicit -e\n"
    fi
  else
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "${RED}✗${NC} No command was executed\n"
  fi
  
  # Cleanup - restore empty exec to prevent global config leaking
  git config happy-trees.exec ""
  git worktree remove "$SANDBOX/test-repo.worktrees/exec-config-1"
  git branch -D exec-config-1
  rm -f "$TEST_MARKER_FILE"
  
  # ============================================================================
  # Test Group 9: Checkout - skip setup
  # ============================================================================
  printf "\n${YELLOW}Test Group: Checkout - Skip Setup${NC}\n"
  
  # Set up a setup script that creates a marker file
  git config happy-trees.setupLocation "<repo_root>/setup-worktree.sh"
  cat > "$TEST_REPO_DIR/setup-worktree.sh" <<'SETUPSCRIPT'
  #!/usr/bin/env bash
  REPO_ROOT="$1"
  WORKTREE_ROOT="$2"
  touch "$WORKTREE_ROOT/.setup-ran"
SETUPSCRIPT
  chmod +x "$TEST_REPO_DIR/setup-worktree.sh"
  
  # Test -s skips setup
  assert_success "git_ht co skip-setup-1 -s" "Creates worktree with -s (skip setup)"
  assert_file_not_exists "$SANDBOX/test-repo.worktrees/skip-setup-1/.setup-ran" "Setup was skipped with -s flag"
  git worktree remove "$SANDBOX/test-repo.worktrees/skip-setup-1"
  git branch -D skip-setup-1
  
  # Test --skip-setup
  assert_success "git_ht co skip-setup-2 --skip-setup" "Creates worktree with --skip-setup"
  assert_file_not_exists "$SANDBOX/test-repo.worktrees/skip-setup-2/.setup-ran" "Setup was skipped with --skip-setup flag"
  git worktree remove "$SANDBOX/test-repo.worktrees/skip-setup-2"
  git branch -D skip-setup-2
  
  # Cleanup config
  git config --unset happy-trees.setupLocation
  rm -f "$TEST_REPO_DIR/setup-worktree.sh"
  
  # ============================================================================
  # Test Group 10: Checkout - auto setup
  # ============================================================================
  printf "\n${YELLOW}Test Group: Checkout - Auto Setup${NC}\n"
  
  # Set up a setup script
  git config happy-trees.setupLocation "<repo_root>/setup-worktree.sh"
  cat > "$TEST_REPO_DIR/setup-worktree.sh" <<'AUTOSETUPSCRIPT'
  #!/usr/bin/env bash
  REPO_ROOT="$1"
  WORKTREE_ROOT="$2"
  touch "$WORKTREE_ROOT/.auto-setup-complete"
AUTOSETUPSCRIPT
  chmod +x "$TEST_REPO_DIR/setup-worktree.sh"
  
  # Test that create automatically runs setup
  assert_success "git_ht co auto-setup-1" "Creates worktree with automatic setup"
  assert_file_exists "$SANDBOX/test-repo.worktrees/auto-setup-1/.auto-setup-complete" "Setup ran automatically after create"
  git worktree remove --force "$SANDBOX/test-repo.worktrees/auto-setup-1"
  git branch -D auto-setup-1
  
  # Test without setup configured (should still create worktree)
  git config --unset happy-trees.setupLocation
  assert_success "git_ht co auto-setup-2" "Creates worktree when setup not configured"
  assert_file_not_exists "$SANDBOX/test-repo.worktrees/auto-setup-2/.auto-setup-complete" "Setup silently skipped when not configured"
  git worktree remove "$SANDBOX/test-repo.worktrees/auto-setup-2"
  git branch -D auto-setup-2
  
  # Test with non-existent setup script (should still create worktree)
  git config happy-trees.setupLocation "<repo_root>/nonexistent.sh"
  assert_success "git_ht co auto-setup-3" "Creates worktree when setup script missing"
  assert_file_not_exists "$SANDBOX/test-repo.worktrees/auto-setup-3/.auto-setup-complete" "Setup silently skipped when script missing"
  git worktree remove "$SANDBOX/test-repo.worktrees/auto-setup-3"
  git branch -D auto-setup-3
  
  # Test with non-executable setup script (should still create worktree)
  echo "#!/bin/sh" > "$TEST_REPO_DIR/non-exec.sh"
  git config happy-trees.setupLocation "<repo_root>/non-exec.sh"
  assert_success "git_ht co auto-setup-4" "Creates worktree when setup script not executable"
  assert_file_not_exists "$SANDBOX/test-repo.worktrees/auto-setup-4/.auto-setup-complete" "Setup silently skipped when script not executable"
  git worktree remove "$SANDBOX/test-repo.worktrees/auto-setup-4"
  git branch -D auto-setup-4
  
  # Test that setup failure doesn't prevent worktree creation
  cat > "$TEST_REPO_DIR/failing-setup.sh" <<'FAILSETUPSCRIPT'
  #!/usr/bin/env bash
  exit 1
FAILSETUPSCRIPT
  chmod +x "$TEST_REPO_DIR/failing-setup.sh"
  git config happy-trees.setupLocation "<repo_root>/failing-setup.sh"
  assert_success "git_ht co auto-setup-5" "Creates worktree even when setup fails"
  assert_file_exists "$SANDBOX/test-repo.worktrees/auto-setup-5" "Worktree created despite setup failure"
  git worktree remove "$SANDBOX/test-repo.worktrees/auto-setup-5"
  git branch -D auto-setup-5
  
  # Cleanup
  git config --unset happy-trees.setupLocation || true
  rm -f "$TEST_REPO_DIR/setup-worktree.sh" "$TEST_REPO_DIR/non-exec.sh" "$TEST_REPO_DIR/failing-setup.sh"
  
  # ============================================================================
  # Test Group 11: Remove - basic
  # ============================================================================
  printf "\n${YELLOW}Test Group: Remove - Basic${NC}\n"
  
  assert_success "git_ht co remove-test-1" "Creates worktree for remove test"
  assert_file_exists "$SANDBOX/test-repo.worktrees/remove-test-1" "Worktree exists before remove"
  assert_success "git_ht remove remove-test-1" "Removes worktree"
  assert_file_not_exists "$SANDBOX/test-repo.worktrees/remove-test-1" "Worktree directory removed"
  # Branch should still exist (no remote branch, so no auto-cleanup)
  assert_success "git branch --list remove-test-1 | grep -q remove-test-1" "Local branch still exists after remove"
  git branch -D remove-test-1
  
  # Test removing non-existent worktree
  assert_output_contains "git_ht remove nonexistent-wt" "No worktree found" "Fails gracefully when removing non-existent worktree"

  # Remove must work on a worktree that lives OUTSIDE worktreesDir, as long as
  # a worktree exists for the named branch. remove is non-destructive and the
  # branch was named explicitly, so location is irrelevant.
  git worktree add "$SANDBOX/other-location/rm-offloc" -b rm-offloc
  assert_success "git_ht remove rm-offloc" "Remove works on an off-location worktree"
  assert_file_not_exists "$SANDBOX/other-location/rm-offloc" "Off-location worktree removed"
  git branch -D rm-offloc 2>/dev/null || true

  # ============================================================================
  # Test Group 12: Remove - auto branch cleanup (SHA matching)
  # ============================================================================
  printf "\n${YELLOW}Test Group: Remove - Auto Branch Cleanup${NC}\n"

  if [ $HAS_REMOTE -eq 1 ]; then
    # Scenario 1: Local and remote SHA match -> branch auto-deleted
    assert_success "git_ht co cleanup-match" "Creates worktree for SHA-match test"
    # Push the branch to origin so local and remote match
    git push -q origin cleanup-match
    # Fetch so we have the remote tracking ref
    git fetch -q origin
    assert_success "git_ht remove cleanup-match" "Removes worktree (SHA match scenario)"
    assert_file_not_exists "$SANDBOX/test-repo.worktrees/cleanup-match" "Worktree directory removed"
    # Local branch should be auto-deleted since SHAs match
    assert_failure "git branch --list cleanup-match | grep -q cleanup-match" "Local branch auto-deleted when SHA matches remote"
    # Cleanup remote branch
    git push -q origin --delete cleanup-match || true

    # Scenario 2: Local and remote SHA don't match -> branch preserved
    assert_success "git_ht co cleanup-nomatch" "Creates worktree for SHA-nomatch test"
    git push -q origin cleanup-nomatch
    git fetch -q origin
    # Make a local commit so SHAs diverge
    git -C "$SANDBOX/test-repo.worktrees/cleanup-nomatch" commit -q --allow-empty -m "local diverge"
    assert_success "git_ht remove cleanup-nomatch" "Removes worktree (SHA mismatch scenario)"
    assert_file_not_exists "$SANDBOX/test-repo.worktrees/cleanup-nomatch" "Worktree directory removed"
    # Local branch should still exist since SHAs differ
    assert_success "git branch --list cleanup-nomatch | grep -q cleanup-nomatch" "Local branch preserved when SHA differs from remote"
    # Cleanup
    git branch -D cleanup-nomatch
    git push -q origin --delete cleanup-nomatch || true
  else
    printf "  (skipped — no remote configured)\n"
  fi

  # Scenario 3: No remote branch -> branch preserved (works with or without remote)
  assert_success "git_ht co cleanup-noremote" "Creates worktree for no-remote test"
  # Don't push to origin
  assert_success "git_ht remove cleanup-noremote" "Removes worktree (no remote scenario)"
  # Local branch should still exist
  assert_success "git branch --list cleanup-noremote | grep -q cleanup-noremote" "Local branch preserved when no remote branch exists"
  git branch -D cleanup-noremote
  
  # ============================================================================
  # Test Group 13: Remove - force
  # ============================================================================
  printf "\n${YELLOW}Test Group: Remove - Force${NC}\n"
  
  assert_success "git_ht co force-remove-test" "Creates worktree for force remove test"
  
  # Make the worktree dirty (uncommitted changes)
  echo "dirty content" > "$SANDBOX/test-repo.worktrees/force-remove-test/dirty-file.txt"
  git -C "$SANDBOX/test-repo.worktrees/force-remove-test" add dirty-file.txt
  
  # Regular remove should fail
  assert_failure "git_ht remove force-remove-test" "Regular remove fails on dirty worktree"
  assert_file_exists "$SANDBOX/test-repo.worktrees/force-remove-test" "Dirty worktree still exists after failed remove"
  
  # Force remove should succeed
  assert_success "git_ht remove force-remove-test --force" "Force remove succeeds on dirty worktree"
  assert_file_not_exists "$SANDBOX/test-repo.worktrees/force-remove-test" "Dirty worktree removed with --force"
  git branch -D force-remove-test
  
  # ============================================================================
  # Test Group 14: Destroy - basic
  # ============================================================================
  printf "\n${YELLOW}Test Group: Destroy - Basic${NC}\n"

  if [ $HAS_REMOTE -eq 1 ]; then
    assert_success "git_ht co destroy-test-1" "Creates worktree for destroy test"
    # Push to remote so destroy can delete both
    git push -q origin destroy-test-1
    git fetch -q origin

    assert_success "git_ht destroy destroy-test-1" "Destroys worktree + branches"
    assert_file_not_exists "$SANDBOX/test-repo.worktrees/destroy-test-1" "Worktree directory removed by destroy"
    assert_failure "git branch --list destroy-test-1 | grep -q destroy-test-1" "Local branch deleted by destroy"
    # Verify remote branch is gone
    assert_failure "git ls-remote --heads origin destroy-test-1 | grep -q destroy-test-1" "Remote branch deleted by destroy"
  else
    # Without a remote, destroy still removes worktree + local branch
    assert_success "git_ht co destroy-test-1" "Creates worktree for destroy test"
    assert_success "git_ht destroy destroy-test-1" "Destroys worktree + local branch (no remote)"
    assert_file_not_exists "$SANDBOX/test-repo.worktrees/destroy-test-1" "Worktree directory removed by destroy"
    assert_failure "git branch --list destroy-test-1 | grep -q destroy-test-1" "Local branch deleted by destroy"
  fi

  # Test destroy with --force on dirty worktree
  assert_success "git_ht co destroy-test-2" "Creates worktree for force destroy test"
  echo "dirty" > "$SANDBOX/test-repo.worktrees/destroy-test-2/dirty.txt"
  git -C "$SANDBOX/test-repo.worktrees/destroy-test-2" add dirty.txt
  assert_failure "git_ht destroy destroy-test-2" "Regular destroy fails on dirty worktree"
  assert_success "git_ht destroy destroy-test-2 --force" "Force destroy succeeds on dirty worktree"
  assert_file_not_exists "$SANDBOX/test-repo.worktrees/destroy-test-2" "Dirty worktree removed by force destroy"
  assert_failure "git branch --list destroy-test-2 | grep -q destroy-test-2" "Local branch deleted by force destroy"

  # --- Destroy path/branch mismatch gate ---------------------------------
  # An off-purpose worktree (path does not reflect its branch) must NOT be
  # destroyed without --force, and the error must explain why + name the config.
  git worktree add "$SANDBOX/other-location/wrong-dest" -b destroy-mismatch
  assert_failure "git_ht destroy destroy-mismatch" "Destroy blocks on path/branch mismatch"
  assert_output_contains "git_ht destroy destroy-mismatch" "path usually indicates the branch" "Mismatch message explains why"
  assert_output_contains "git_ht destroy destroy-mismatch" "failDestroyOnPathMismatch" "Mismatch message names the config to disable it"
  # --force overrides the mismatch gate.
  assert_success "git_ht destroy destroy-mismatch --force" "Force destroy overrides mismatch gate"
  assert_file_not_exists "$SANDBOX/other-location/wrong-dest" "Mismatched worktree removed by force destroy"
  git branch -D destroy-mismatch 2>/dev/null || true

  # --- Destroy reports BOTH mismatch and dirty together ------------------
  git worktree add "$SANDBOX/other-location/wrong-dirty" -b destroy-both
  echo "dirty" > "$SANDBOX/other-location/wrong-dirty/dirty.txt"
  git -C "$SANDBOX/other-location/wrong-dirty" add dirty.txt
  assert_output_contains "git_ht destroy destroy-both" "path usually indicates the branch" "Combined message reports mismatch"
  assert_output_contains "git_ht destroy destroy-both" "uncommitted changes" "Combined message reports dirty worktree"
  assert_success "git_ht destroy destroy-both --force" "Force destroy overrides both gates"
  git branch -D destroy-both 2>/dev/null || true

  # --- failDestroyOnPathMismatch=false disables ONLY the mismatch gate ----
  git config happy-trees.failDestroyOnPathMismatch false
  # Clean mismatched worktree: destroy succeeds without --force.
  git worktree add "$SANDBOX/other-location/wrong-clean" -b destroy-cfg-clean
  assert_success "git_ht destroy destroy-cfg-clean" "Config-disabled mismatch gate lets clean destroy proceed"
  git branch -D destroy-cfg-clean 2>/dev/null || true
  # Dirty mismatched worktree: still blocked (config disables mismatch, not dirty).
  git worktree add "$SANDBOX/other-location/wrong-cfgdirty" -b destroy-cfg-dirty
  echo "dirty" > "$SANDBOX/other-location/wrong-cfgdirty/dirty.txt"
  git -C "$SANDBOX/other-location/wrong-cfgdirty" add dirty.txt
  assert_failure "git_ht destroy destroy-cfg-dirty" "Dirty worktree still blocks destroy when mismatch gate is config-disabled"
  assert_success "git_ht destroy destroy-cfg-dirty --force" "Force destroy proceeds on dirty when mismatch gate is config-disabled"
  git branch -D destroy-cfg-dirty 2>/dev/null || true
  git config --unset happy-trees.failDestroyOnPathMismatch

  # --- Off-location but name-matching worktree destroys cleanly -----------
  git worktree add "$SANDBOX/other-location/dest-ok" -b dest-ok
  assert_success "git_ht destroy dest-ok" "Off-location name-matching worktree destroys with no gate tripped"
  git branch -D dest-ok 2>/dev/null || true

  # ============================================================================
  # Test Group 15: Destroy - default branch protection
  # ============================================================================
  printf "\n${YELLOW}Test Group: Destroy - Default Branch Protection${NC}\n"
  
  # Trying to destroy master (the default branch) should fail.
  # We need a worktree for master first. But master is the current branch in the
  # main repo, so we can't create a worktree for it directly. Instead, test the
  # error message by just calling destroy with the branch name.
  assert_output_contains "git_ht destroy master" "Cannot destroy the default branch" "Errors when trying to destroy default branch"
  
  # ============================================================================
  # Test Group: Commands from inside a worktree
  # ============================================================================
  printf "\n${YELLOW}Test Group: Commands from Inside a Worktree${NC}\n"

  # Create a "home base" worktree to run commands from
  assert_success "git_ht co wt-home" "Creates home worktree"
  cd "$SANDBOX/test-repo.worktrees/wt-home"

  # Checkout another worktree while inside wt-home
  assert_success "git_ht co wt-sibling" "Checkout creates sibling worktree from inside a worktree"
  assert_file_exists "$SANDBOX/test-repo.worktrees/wt-sibling" "Sibling worktree directory exists"
  assert_success "git branch --list wt-sibling | grep -q wt-sibling" "Sibling branch was created"

  # Remove sibling worktree from inside wt-home
  assert_success "git_ht remove wt-sibling" "Remove works from inside a worktree"
  assert_file_not_exists "$SANDBOX/test-repo.worktrees/wt-sibling" "Sibling worktree removed"

  # Destroy from inside wt-home
  assert_success "git_ht co wt-to-destroy" "Creates worktree to destroy"
  if [ $HAS_REMOTE -eq 1 ]; then
    git push -q origin wt-to-destroy
  fi
  assert_success "git_ht destroy wt-to-destroy" "Destroy works from inside a worktree"
  assert_file_not_exists "$SANDBOX/test-repo.worktrees/wt-to-destroy" "Destroyed worktree removed"
  assert_failure "git branch --list wt-to-destroy | grep -q wt-to-destroy" "Destroyed branch deleted"

  # Return to main repo and cleanup
  cd "$TEST_REPO_DIR"
  git worktree remove "$SANDBOX/test-repo.worktrees/wt-home"
  git branch -D wt-home
  git branch -D wt-sibling 2>/dev/null || true

  # ============================================================================
  # Test Group 16: Setup - init
  # ============================================================================
  printf "\n${YELLOW}Test Group: Setup - Init Mode${NC}\n"
  
  assert_success "git_ht setup --init" "Creates setup script with --init"
  assert_file_exists "$TEST_REPO_DIR/setup-worktree.sh" "Setup script exists in repo root"
  
  # Verify script is executable
  if [ -x "$TEST_REPO_DIR/setup-worktree.sh" ]; then
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_PASSED=$((TESTS_PASSED + 1))
    printf "${GREEN}✓${NC} Setup script is executable\n"
  else
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "${RED}✗${NC} Setup script is not executable\n"
  fi
  
  # Verify git config was set
  setup_location=$(git config happy-trees.setupLocation)
  if [ -n "$setup_location" ]; then
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_PASSED=$((TESTS_PASSED + 1))
    printf "${GREEN}✓${NC} Git config happy-trees.setupLocation is set\n"
  else
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "${RED}✗${NC} Git config happy-trees.setupLocation is not set\n"
  fi
  
  # Verify script contains expected content
  if grep -q "#!/usr/bin/env bash" "$TEST_REPO_DIR/setup-worktree.sh" && \
     grep -q "REPO_ROOT=\"\$1\"" "$TEST_REPO_DIR/setup-worktree.sh" && \
     grep -q "WORKTREE_ROOT=\"\$2\"" "$TEST_REPO_DIR/setup-worktree.sh"; then
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_PASSED=$((TESTS_PASSED + 1))
    printf "${GREEN}✓${NC} Setup script contains expected template content\n"
  else
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "${RED}✗${NC} Setup script missing expected template content\n"
  fi
  
  # Cleanup init test
  rm -f "$TEST_REPO_DIR/setup-worktree.sh"
  git config --unset happy-trees.setupLocation
  
  # Test --init with custom relative path
  assert_success "git_ht setup --init scripts/initWorktree.sh" "Creates setup script at relative path"
  assert_file_exists "$TEST_REPO_DIR/scripts/initWorktree.sh" "Script created at relative path"
  
  config_value=$(git config happy-trees.setupLocation)
  if echo "$config_value" | grep -q "^<repo_root>/scripts/initWorktree.sh$"; then
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_PASSED=$((TESTS_PASSED + 1))
    printf "${GREEN}✓${NC} Config uses <repo_root> token for relative path\n"
  else
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "${RED}✗${NC} Config doesn't use <repo_root> token: %s\n" "$config_value"
  fi
  
  rm -rf "$TEST_REPO_DIR/scripts"
  git config --unset happy-trees.setupLocation
  
  # Test --init with absolute path
  assert_success "git_ht setup --init '$SANDBOX/absolute-setup.sh'" "Creates setup script at absolute path"
  assert_file_exists "$SANDBOX/absolute-setup.sh" "Script created at absolute path"
  
  config_value=$(git config happy-trees.setupLocation)
  if [ "$config_value" = "$SANDBOX/absolute-setup.sh" ]; then
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_PASSED=$((TESTS_PASSED + 1))
    printf "${GREEN}✓${NC} Config uses literal absolute path\n"
  else
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "${RED}✗${NC} Config doesn't use literal path: %s\n" "$config_value"
  fi
  
  rm -f "$SANDBOX/absolute-setup.sh"
  git config --unset happy-trees.setupLocation
  
  # Test --init with non-.sh extension
  assert_success "git_ht setup --init scripts/initWorktree.js" "Creates setup script with .js extension"
  assert_file_exists "$TEST_REPO_DIR/scripts/initWorktree.js" "Script created with .js extension"
  
  if [ ! -x "$TEST_REPO_DIR/scripts/initWorktree.js" ]; then
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_PASSED=$((TESTS_PASSED + 1))
    printf "${GREEN}✓${NC} Non-.sh script is not auto-executable\n"
  else
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "${RED}✗${NC} Non-.sh script was made executable\n"
  fi
  
  if grep -q "non-.sh extension" "$TEST_REPO_DIR/scripts/initWorktree.js" && \
     grep -q "argv\[1\]" "$TEST_REPO_DIR/scripts/initWorktree.js"; then
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_PASSED=$((TESTS_PASSED + 1))
    printf "${GREEN}✓${NC} Non-.sh script contains appropriate template\n"
  else
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "${RED}✗${NC} Non-.sh script missing expected template content\n"
  fi
  
  rm -rf "$TEST_REPO_DIR/scripts"
  git config --unset happy-trees.setupLocation
  
  # Test --init creates nested parent directories
  assert_success "git_ht setup --init deeply/nested/path/setup.sh" "Creates setup script with nested directories"
  assert_file_exists "$TEST_REPO_DIR/deeply/nested/path/setup.sh" "Script created in nested directory"
  rm -rf "$TEST_REPO_DIR/deeply"
  git config --unset happy-trees.setupLocation
  
  # Test --init safety: fails if config already exists
  git config happy-trees.setupLocation "<repo_root>/existing-setup.sh"
  assert_output_contains "git_ht setup --init" "already configured" "Fails when setupLocation config already exists"
  assert_file_not_exists "$TEST_REPO_DIR/setup-worktree.sh" "No file created when config exists"
  git config --unset happy-trees.setupLocation
  
  # Test --init safety: fails if file already exists
  echo "existing content" > "$TEST_REPO_DIR/setup-worktree.sh"
  assert_output_contains "git_ht setup --init" "already exists" "Fails when destination file already exists"
  rm -f "$TEST_REPO_DIR/setup-worktree.sh"
  git config --unset happy-trees.setupLocation || true
  
  # ============================================================================
  # Test Group 17: Setup - run from worktree
  # ============================================================================
  printf "\n${YELLOW}Test Group: Setup - Run from Worktree${NC}\n"
  
  # Set up a working setup script and config
  git config happy-trees.setupLocation "<repo_root>/setup-worktree.sh"
  cat > "$TEST_REPO_DIR/setup-worktree.sh" <<'SETUPSCRIPT'
  #!/usr/bin/env bash
  REPO_ROOT="$1"
  WORKTREE_ROOT="$2"
  echo "repo_root=$REPO_ROOT" > "$WORKTREE_ROOT/.setup-marker"
  echo "worktree_root=$WORKTREE_ROOT" >> "$WORKTREE_ROOT/.setup-marker"
  echo "Setup complete" > "$WORKTREE_ROOT/.setup-complete"
SETUPSCRIPT
  chmod +x "$TEST_REPO_DIR/setup-worktree.sh"
  
  # Create a worktree for testing setup
  assert_success "git_ht co setup-run-test -s" "Creates worktree for setup run test (skip auto-setup)"
  
  # Run setup from inside the worktree
  cd "$SANDBOX/test-repo.worktrees/setup-run-test"
  assert_success "git_ht setup" "Runs setup from inside worktree"
  assert_file_exists "$SANDBOX/test-repo.worktrees/setup-run-test/.setup-marker" "Setup script created marker file"
  assert_file_exists "$SANDBOX/test-repo.worktrees/setup-run-test/.setup-complete" "Setup script completed successfully"
  
  # Verify arguments were passed correctly
  if [ -f "$SANDBOX/test-repo.worktrees/setup-run-test/.setup-marker" ]; then
    marker_content=$(cat "$SANDBOX/test-repo.worktrees/setup-run-test/.setup-marker")
    expected_repo_root=$(cd "$TEST_REPO_DIR" && pwd)
    expected_worktree_root=$(cd "$SANDBOX/test-repo.worktrees/setup-run-test" && pwd)
  
    if echo "$marker_content" | grep -q "repo_root=$expected_repo_root" && \
       echo "$marker_content" | grep -q "worktree_root=$expected_worktree_root"; then
      TESTS_RUN=$((TESTS_RUN + 1))
      TESTS_PASSED=$((TESTS_PASSED + 1))
      printf "${GREEN}✓${NC} Setup script received correct arguments\n"
    else
      TESTS_RUN=$((TESTS_RUN + 1))
      TESTS_FAILED=$((TESTS_FAILED + 1))
      printf "${RED}✗${NC} Setup script received wrong arguments\n"
      printf "  Marker content: %s\n" "$marker_content"
    fi
  fi
  
  # Return to test repo
  cd "$TEST_REPO_DIR"
  
  # Cleanup
  git worktree remove --force "$SANDBOX/test-repo.worktrees/setup-run-test"
  git branch -D setup-run-test
  
  # Regression: repo root resolution must not be confused by a "/worktrees/"
  # segment that appears ABOVE the repo in the filesystem path (e.g. checkouts
  # living under .claude/worktrees/<name>/). git's linked-worktree git-dir is
  # always <common-dir>/worktrees/<name>, so only the LAST occurrence delimits
  # the repo root; stripping from the first one yields a bogus root and the
  # <repo_root> token then expands outside the repo.
  nested_wt_dir="$SANDBOX/worktrees/inner/test-repo.worktrees"
  original_wt_dir=$(git config happy-trees.worktreesDir)
  git config happy-trees.worktreesDir "$nested_wt_dir"
  assert_success "git_ht co nested-path-test -s" \
    "Creates worktree under a path containing a nested /worktrees/ segment"
  cd "$nested_wt_dir/nested-path-test"
  assert_success "git_ht setup" \
    "Runs setup when repo path contains an outer /worktrees/ segment"
  assert_file_exists "$nested_wt_dir/nested-path-test/.setup-marker" \
    "Setup ran with correctly resolved repo root under nested /worktrees/ path"

  cd "$TEST_REPO_DIR"
  git worktree remove --force "$nested_wt_dir/nested-path-test"
  git branch -D nested-path-test
  rm -rf "$SANDBOX/worktrees"
  git config happy-trees.worktreesDir "$original_wt_dir"

  # Cleanup setup script and config from prior group
  rm -f "$TEST_REPO_DIR/setup-worktree.sh"
  git config --unset happy-trees.setupLocation
  
  # ============================================================================
  # Test Group: Setup - Token Expansion
  # ============================================================================
  printf "\n${YELLOW}Test Group: Setup - Token Expansion${NC}\n"
  
  # Create a setup script that records the arguments it receives
  cat > "$TEST_REPO_DIR/token-test-setup.sh" <<'TOKENSCRIPT'
  #!/usr/bin/env bash
  REPO_ROOT="$1"
  WORKTREE_ROOT="$2"
  echo "repo_root=$REPO_ROOT" > "$WORKTREE_ROOT/.token-marker"
  echo "worktree_root=$WORKTREE_ROOT" >> "$WORKTREE_ROOT/.token-marker"
TOKENSCRIPT
  chmod +x "$TEST_REPO_DIR/token-test-setup.sh"
  
  # Test <repo_root> token in setupLocation
  git config happy-trees.setupLocation "<repo_root>/token-test-setup.sh"
  assert_success "git_ht co token-test-1 -s" "Creates worktree for token expansion test"
  cd "$SANDBOX/test-repo.worktrees/token-test-1"
  assert_success "git_ht setup" "Runs setup with <repo_root> token in setupLocation"
  assert_file_exists "$SANDBOX/test-repo.worktrees/token-test-1/.token-marker" "Setup script ran with <repo_root> token"
  
  # Verify <repo_root> expanded correctly (script received correct repo root)
  if [ -f "$SANDBOX/test-repo.worktrees/token-test-1/.token-marker" ]; then
    expected_repo_root=$(cd "$TEST_REPO_DIR" && pwd)
    if grep -q "repo_root=$expected_repo_root" "$SANDBOX/test-repo.worktrees/token-test-1/.token-marker"; then
      TESTS_RUN=$((TESTS_RUN + 1))
      TESTS_PASSED=$((TESTS_PASSED + 1))
      printf "${GREEN}✓${NC} <repo_root> token expanded correctly in setupLocation\n"
    else
      TESTS_RUN=$((TESTS_RUN + 1))
      TESTS_FAILED=$((TESTS_FAILED + 1))
      printf "${RED}✗${NC} <repo_root> token did not expand correctly\n"
    fi
  fi
  
  # Verify <worktree_root> was passed correctly as argument to setup script
  if [ -f "$SANDBOX/test-repo.worktrees/token-test-1/.token-marker" ]; then
    expected_wt_root=$(cd "$SANDBOX/test-repo.worktrees/token-test-1" && pwd)
    if grep -q "worktree_root=$expected_wt_root" "$SANDBOX/test-repo.worktrees/token-test-1/.token-marker"; then
      TESTS_RUN=$((TESTS_RUN + 1))
      TESTS_PASSED=$((TESTS_PASSED + 1))
      printf "${GREEN}✓${NC} Worktree root passed correctly to setup script\n"
    else
      TESTS_RUN=$((TESTS_RUN + 1))
      TESTS_FAILED=$((TESTS_FAILED + 1))
      printf "${RED}✗${NC} Worktree root not passed correctly\n"
    fi
  fi
  
  cd "$TEST_REPO_DIR"
  git worktree remove --force "$SANDBOX/test-repo.worktrees/token-test-1"
  git branch -D token-test-1
  
  # Test <repo_name> token in worktreesDir
  # Save original worktreesDir and set one using <repo_name>
  original_wt_dir=$(git config happy-trees.worktreesDir)
  git config happy-trees.worktreesDir "$SANDBOX/<repo_name>.trees"
  assert_success "git_ht co token-test-2 -s" "Creates worktree with <repo_name> token in worktreesDir"
  assert_file_exists "$SANDBOX/test-repo.trees/token-test-2" "Worktree created in directory with expanded <repo_name>"
  
  # Cleanup
  git worktree remove --force "$SANDBOX/test-repo.trees/token-test-2"
  git branch -D token-test-2
  rm -rf "$SANDBOX/test-repo.trees"
  git config happy-trees.worktreesDir "$original_wt_dir"
  
  # Test <worktree_root> token in setupLocation
  cat > "$TEST_REPO_DIR/wt-token-setup.sh" <<'WTTOKENSCRIPT'
  #!/usr/bin/env bash
  echo "ran" > "$2/.wt-token-ran"
WTTOKENSCRIPT
  chmod +x "$TEST_REPO_DIR/wt-token-setup.sh"
  
  # Use a setupLocation that uses <repo_root> to point to the script
  git config happy-trees.setupLocation "<repo_root>/wt-token-setup.sh"
  assert_success "git_ht co token-test-3 -s" "Creates worktree for <worktree_root> token test"
  cd "$SANDBOX/test-repo.worktrees/token-test-3"
  assert_success "git_ht setup" "Runs setup script located via <repo_root> token"
  assert_file_exists "$SANDBOX/test-repo.worktrees/token-test-3/.wt-token-ran" "Setup script ran in worktree context"
  
  cd "$TEST_REPO_DIR"
  git worktree remove --force "$SANDBOX/test-repo.worktrees/token-test-3"
  git branch -D token-test-3
  
  # Cleanup
  rm -f "$TEST_REPO_DIR/token-test-setup.sh" "$TEST_REPO_DIR/wt-token-setup.sh"
  git config --unset happy-trees.setupLocation
  
  # ============================================================================
  # Test Group: Setup - Errors
  # ============================================================================
  printf "\n${YELLOW}Test Group: Setup - Errors${NC}\n"
  
  # Test: not configured
  git config --unset happy-trees.setupLocation || true
  assert_output_contains "git_ht setup" "not configured" "Fails gracefully when setupLocation not configured"
  
  # Test: not in a linked worktree (running from main repo)
  git config happy-trees.setupLocation "<repo_root>/setup-worktree.sh"
  assert_output_contains "git_ht setup" "linked worktree" "Fails when run from main worktree"
  
  # Test: script not found
  assert_success "git_ht co setup-err-test -s" "Creates worktree for setup error test"
  cd "$SANDBOX/test-repo.worktrees/setup-err-test"
  git config happy-trees.setupLocation "<repo_root>/nonexistent-setup.sh"
  assert_output_contains "git_ht setup" "not found" "Fails when script doesn't exist"
  
  # Test: script not executable
  echo "#!/bin/sh" > "$TEST_REPO_DIR/non-exec-setup.sh"
  git config happy-trees.setupLocation "<repo_root>/non-exec-setup.sh"
  assert_output_contains "git_ht setup" "not executable" "Fails when script is not executable"
  
  # Test: script fails
  cat > "$TEST_REPO_DIR/fail-setup.sh" <<'FAILSCRIPT'
  #!/usr/bin/env bash
  exit 1
FAILSCRIPT
  chmod +x "$TEST_REPO_DIR/fail-setup.sh"
  git config happy-trees.setupLocation "<repo_root>/fail-setup.sh"
  assert_output_contains "git_ht setup" "failed" "Reports when setup script fails"
  
  # Return to test repo and cleanup
  cd "$TEST_REPO_DIR"
  git worktree remove --force "$SANDBOX/test-repo.worktrees/setup-err-test"
  git branch -D setup-err-test
  rm -f "$TEST_REPO_DIR/setup-worktree.sh" "$TEST_REPO_DIR/non-exec-setup.sh" "$TEST_REPO_DIR/fail-setup.sh"
  git config --unset happy-trees.setupLocation || true
  
  # Cleanup remaining worktree from group 2
  git worktree remove "$SANDBOX/test-repo.worktrees/new-branch-1" 2>/dev/null || true
  git branch -D new-branch-1 2>/dev/null || true
  
  # Cleanup test commands
  rm -rf "$SANDBOX/test-commands"
  rm -f "$TEST_MARKER_FILE"
  
} # end run_all_tests

# ============================================================================
# Run both passes
# ============================================================================

# Pass 1: Normal (non-bare) local repo with remote
setup_test_repo normal
printf "\n${YELLOW}=== Testing git-ht (normal repo) ===${NC}\n\n"
run_all_tests
cleanup

# Pass 2: Bare local repo with remote
setup_test_repo bare
printf "\n${YELLOW}=== Testing git-ht (bare repo) ===${NC}\n\n"
run_all_tests
cleanup

# Pass 3: Normal (non-bare) local repo without remote
setup_test_repo normal-noremote
printf "\n${YELLOW}=== Testing git-ht (normal repo, no remote) ===${NC}\n\n"
run_all_tests
cleanup

# Pass 4: Bare local repo without remote
setup_test_repo bare-noremote
printf "\n${YELLOW}=== Testing git-ht (bare repo, no remote) ===${NC}\n\n"
run_all_tests

# ============================================================================
# Print summary
# ============================================================================
printf "\n${YELLOW}=== Test Summary ===${NC}\n"
printf "Tests run:    %d\n" "$TESTS_RUN"
printf "Tests passed: ${GREEN}%d${NC}\n" "$TESTS_PASSED"
printf "Tests failed: ${RED}%d${NC}\n" "$TESTS_FAILED"

if [ $TESTS_FAILED -eq 0 ]; then
  printf "\n${GREEN}All tests passed!${NC}\n"
  exit 0
else
  printf "\n${RED}Some tests failed!${NC}\n"
  exit 1
fi

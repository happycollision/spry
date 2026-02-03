#!/bin/bash
set -e

# Read the command from stdin
COMMAND=$(jq -r '.tool_input.command' < /dev/stdin)

# Check if it's a find command with dangerous flags
if [[ "$COMMAND" =~ ^find[[:space:]] ]]; then
  # Check for various dangerous patterns
  if [[ "$COMMAND" =~ (--exec|-exec|-execdir|--execdir|-ok|-okdir|-delete|--delete) ]]; then
    # Determine which dangerous flag was found
    REASON="find command with dangerous flag requires approval"
    if [[ "$COMMAND" =~ -delete|--delete ]]; then
      REASON="find command with -delete flag (deletes files) requires approval"
    elif [[ "$COMMAND" =~ -execdir|--execdir ]]; then
      REASON="find command with -execdir flag (executes commands) requires approval"
    elif [[ "$COMMAND" =~ -exec|--exec ]]; then
      REASON="find command with -exec flag (executes commands) requires approval"
    elif [[ "$COMMAND" =~ -ok|-okdir ]]; then
      REASON="find command with -ok/-okdir flag (executes commands) requires approval"
    fi

    jq -n --arg reason "$REASON" '{
      "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "ask",
        "permissionDecisionReason": $reason
      }
    }'
    exit 0
  fi

  # Check if find is piped to dangerous commands
  if [[ "$COMMAND" =~ \|[[:space:]]*xargs[[:space:]]+(rm|mv|chmod|chown) ]] ||
     [[ "$COMMAND" =~ \|[[:space:]]*xargs.*-.*[[:space:]]+(rm|mv|chmod|chown) ]]; then
    jq -n '{
      "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "ask",
        "permissionDecisionReason": "find piped to xargs with destructive command requires approval"
      }
    }'
    exit 0
  fi

  # If we get here, it's a safe find command - explicitly allow it
  jq -n '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "allow",
      "permissionDecisionReason": "Safe find command without dangerous flags"
    }
  }'
  exit 0
fi

# For all non-find commands, exit without JSON to defer to normal permission system
exit 0

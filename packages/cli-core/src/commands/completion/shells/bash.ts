/**
 * Generate a bash completion script for the CLI.
 *
 * Bash completions use the `complete` builtin to register a function that
 * populates the COMPREPLY array. Bash does not support displaying descriptions
 * next to completion candidates.
 */
export function generate(binaryName: string): string {
  return `# Bash completion for ${binaryName}
# Add to ~/.bashrc:
#   eval "$(${binaryName} completion bash)"
# Or save to a file:
#   ${binaryName} completion bash > /etc/bash_completion.d/${binaryName}

_${binaryName}_completions() {
    local cur prev words cword
    _init_completion -n = 2>/dev/null || {
        cur="\${COMP_WORDS[COMP_CWORD]}"
        prev="\${COMP_WORDS[COMP_CWORD-1]}"
        words=("\${COMP_WORDS[@]}")
        cword=$COMP_CWORD
    }

    local IFS=$'\\n'
    local output
    output=$("${binaryName}" __complete "\${COMP_WORDS[@]:1}" 2>/dev/null)
    local rc=$?
    if [ $rc -ne 0 ]; then
        return
    fi

    # Extract directive from last line
    local directive
    directive=$(echo "$output" | tail -n1 | tr -d ':')
    output=$(echo "$output" | head -n-1)

    # Parse completions (take first field before tab)
    local -a completions
    while IFS=$'\\t' read -r comp _desc; do
        [ -n "$comp" ] && completions+=("$comp")
    done <<< "$output"

    COMPREPLY=($(compgen -W "\${completions[*]}" -- "$cur"))

    # Handle directive: bit 4 = no file completion
    if (( directive & 4 )); then
        compopt +o default 2>/dev/null
    fi
}

complete -o default -F _${binaryName}_completions ${binaryName}
`;
}

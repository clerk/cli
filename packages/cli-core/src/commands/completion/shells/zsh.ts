/**
 * Generate a zsh completion script for the CLI.
 *
 * Zsh completions use the `_describe` function to display candidates with
 * descriptions. The script registers via `compdef` and can be placed in
 * any directory on $fpath as a file named `_<binaryName>`.
 */
export function generate(binaryName: string): string {
  // Use a variable for $'\t' to avoid lint warnings about escaped $ in template literals
  const tab = "$'\\t'";

  return `#compdef ${binaryName}
# Zsh completion for ${binaryName}
# Add to ~/.zshrc:
#   eval "$(${binaryName} completion zsh)"
# Or save to a file in your $fpath:
#   mkdir -p ~/.zfunc
#   ${binaryName} completion zsh > ~/.zfunc/_${binaryName}
#   # Then ensure ~/.zshrc contains:
#   #   fpath=(~/.zfunc $fpath)
#   #   autoload -Uz compinit && compinit

_${binaryName}() {
    local -a completions
    local directive output

    output=("\${(@f)$( ${binaryName} __complete "\${words[@]:1}" 2>/dev/null)}")
    if (( \${#output} == 0 )); then
        return
    fi

    # Last line is the directive
    directive="\${output[-1]#:}"
    output=("\${output[@]:0:$(("\${#output[@]}-1"))}")

    local -a candidates
    for line in "\${output[@]}"; do
        if [[ -z "$line" ]]; then
            continue
        fi
        local comp="\${line%%${tab}*}"
        local desc="\${line#*${tab}}"
        if [[ "$comp" == "$desc" ]]; then
            candidates+=("$comp")
        else
            candidates+=("$comp:$desc")
        fi
    done

    _describe '${binaryName}' candidates

    # Only allow file completion fallback when directive permits it (bit 4 NOT set)
    if (( !(directive & 4) )); then
        _files
    fi
}

compdef _${binaryName} ${binaryName}
`;
}

/**
 * Generate a fish completion script for the CLI.
 *
 * Fish completions use a declarative `complete` command and natively parse
 * tab-separated `candidate\tdescription` format. Save the output to
 * ~/.config/fish/completions/<binaryName>.fish for auto-discovery.
 */
export function generate(binaryName: string): string {
  return `# Fish completion for ${binaryName}
# Save to:
#   mkdir -p ~/.config/fish/completions
#   ${binaryName} completion fish > ~/.config/fish/completions/${binaryName}.fish

function __${binaryName}_prepare_completions
    set -g __${binaryName}_comp_results
    set -l tokens (commandline -opc)
    set -l current (commandline -ct)

    # Remove the command name, pass the rest + current token to __complete
    set -l args $tokens[2..]
    set -l output (${binaryName} __complete $args $current 2>/dev/null)

    if test $status -ne 0; or test (count $output) -eq 0
        return 0
    end

    # Last line is the directive; the rest are the candidates
    set -l directive (string replace ':' '' -- $output[-1])
    set -e output[-1]
    set -g __${binaryName}_comp_results $output

    # Nothing starts with what was typed, and the directive allows files (bit 4,
    # NO_FILE_COMP, clear): false skips the entry below, so fish completes files.
    set -l names (string replace -r '\\t.*' '' -- $output)
    if not string match -q -- "$current*" $names; and test (math --scale 0 $directive / 4 % 2) -eq 0
        return 1
    end
    return 0
end

# The candidates, with files off, whenever __complete has something to offer
complete -c ${binaryName} -n '__${binaryName}_prepare_completions' -f -a '$__${binaryName}_comp_results'
`;
}

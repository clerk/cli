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
#   ${binaryName} completion fish > ~/.config/fish/completions/${binaryName}.fish

function __${binaryName}_complete
    set -l tokens (commandline -opc)
    set -l current (commandline -ct)

    # Remove the command name, pass the rest + current token to __complete
    set -l args $tokens[2..]
    set -l output (${binaryName} __complete $args $current 2>/dev/null)

    if test $status -ne 0
        return
    end

    # Last line is the directive — skip it
    set -l count (count $output)
    if test $count -le 1
        return
    end

    # Output all lines except the last (directive)
    for i in (seq 1 (math $count - 1))
        echo $output[$i]
    end
end

# Disable file completions by default, let __complete control it
complete -c ${binaryName} -f -a '(__${binaryName}_complete)'
`;
}

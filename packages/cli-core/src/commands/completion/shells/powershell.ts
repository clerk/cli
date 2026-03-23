/**
 * Generate a PowerShell completion script for the CLI.
 *
 * PowerShell uses Register-ArgumentCompleter to register a native completer.
 * The script block emits [CompletionResult] objects with description tooltips.
 * Add the output to your $PROFILE for persistence across sessions.
 */
export function generate(binaryName: string): string {
  return `# PowerShell completion for ${binaryName}
# Add to your $PROFILE:
#   ${binaryName} completion powershell | Out-String | Invoke-Expression
# Or append to your profile:
#   ${binaryName} completion powershell >> $PROFILE

Register-ArgumentCompleter -CommandName '${binaryName}' -Native -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    $commandLine = $commandAst.ToString()
    $words = $commandLine.Split(' ') | Select-Object -Skip 1

    $output = & ${binaryName} __complete @words '' 2>$null
    if (-not $output) { return }

    $lines = $output -split "\\n"
    $count = $lines.Count
    if ($count -le 1) { return }

    # Last line is the directive
    $directive = [int]($lines[$count - 1] -replace ':', '')

    for ($i = 0; $i -lt $count - 1; $i++) {
        $line = $lines[$i]
        if (-not $line) { continue }

        $parts = $line -split "\\t", 2
        $text = $parts[0]
        $desc = if ($parts.Count -gt 1) { $parts[1] } else { $text }
        $type = if ($text -like '-*') { 'ParameterName' } else { 'ParameterValue' }

        [System.Management.Automation.CompletionResult]::new($text, $text, $type, $desc)
    }
}
`;
}

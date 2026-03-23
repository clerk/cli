# Completion Command

Generate shell autocompletion scripts for the Clerk CLI. Supports bash, zsh, fish, and PowerShell.

## Usage

```sh
clerk completion bash         # Output bash completion script
clerk completion zsh          # Output zsh completion script
clerk completion fish         # Output fish completion script
clerk completion powershell   # Output PowerShell completion script
```

## Installation per Shell

### Bash

```sh
# Enable in current session
eval "$(clerk completion bash)"

# Or install permanently
clerk completion bash > /etc/bash_completion.d/clerk
# Or append to ~/.bashrc:
echo 'eval "$(clerk completion bash)"' >> ~/.bashrc
```

### Zsh

```sh
# Enable in current session
eval "$(clerk completion zsh)"

# Or install permanently
mkdir -p ~/.zfunc
clerk completion zsh > ~/.zfunc/_clerk
# Ensure ~/.zshrc contains:
#   fpath=(~/.zfunc $fpath)
#   autoload -Uz compinit && compinit
```

### Fish

```sh
# Fish auto-discovers completion files — just save it
clerk completion fish > ~/.config/fish/completions/clerk.fish
```

### PowerShell

```powershell
# Enable in current session
clerk completion powershell | Out-String | Invoke-Expression

# Or install permanently
clerk completion powershell >> $PROFILE
```

## How It Works

The `completion` command outputs a shell script to stdout. The script registers a completion handler that calls `clerk __complete` (a hidden internal command) on every Tab press. The `__complete` command walks the CLI's command tree and returns matching candidates.

### What gets completed

- Command and subcommand names (e.g., `clerk au<TAB>` → `auth`)
- Command aliases (e.g., `clerk auth sign<TAB>` → `signin`, `signup`, etc.)
- Option flags (e.g., `clerk link --<TAB>` → `--app`, `--yes`, etc.)
- Known option values (e.g., `clerk --mode <TAB>` → `human`, `agent`)

### Internal: `__complete`

The hidden `__complete` subcommand is invoked by the shell completion scripts. It is not intended for direct use. It outputs tab-separated `candidate\tdescription` lines followed by a Cobra-style directive on the final line.

## Clerk API Endpoints

This command makes no API calls.

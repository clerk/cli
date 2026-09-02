---
"clerk": patch
---

Reject an invalid `clerk api` request body on your machine instead of sending it. The error echoes what arrived and, when a `-d` value reached the CLI with its double quotes stripped or wrapped in literal single quotes, names the shell quoting behind it — an unquoted body in a POSIX shell, or PowerShell before 7.3 and cmd.exe on Windows — and suggests the same request with `--file`, which no shell can mangle. Those shell-quoting rejections carry the error code `invalid_json_shell_quoting`; other parse failures keep `invalid_json`.

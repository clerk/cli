# The honest edges. Everything keyless mode cannot do says so plainly,
# names the reason, and tells you the one command that lifts the limit.

Output ../out/06-guardrails.gif
Output ../out/06-guardrails.mp4

Source "_common.tape"

Hide
Type "source ../lib/demo-env.sh && quiet_shell && new_project guardrails && keyless_keys && clear" Enter
Show

Sleep 1s
Type `clerk config put --json '{"instance":{}}' --yes`
Sleep 500ms
Enter
Sleep 6s

Type `clerk config patch --json '{"session":{"lifetime":3600}}' --yes`
Sleep 500ms
Enter
Sleep 7s

Type `clerk config patch --instance prod --json '{"instance":{}}' --yes`
Sleep 500ms
Enter
Sleep 6s

Type "clerk enable billing"
Sleep 500ms
Enter
Sleep 6s
Sleep 2s

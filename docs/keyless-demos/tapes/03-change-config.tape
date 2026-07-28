# Change the configuration of an unclaimed keyless application.
# Preview first, then apply, then read it back from the API.

Output ../out/03-change-config.gif
Output ../out/03-change-config.mp4

Source "_common.tape"

Hide
Type "source ../lib/demo-env.sh && quiet_shell && new_project change-config && keyless_keys && clear" Enter
Show

Sleep 1s
Type "# --dry-run diffs locally and sends nothing"
Enter
Type `clerk config patch --json '{"instance":{"support_email":"help@acme.dev"}}' --dry-run`
Sleep 700ms
Enter
Sleep 8s

Type `clerk config patch --json '{"instance":{"support_email":"help@acme.dev"}}' --yes`
Sleep 700ms
Enter
Sleep 9s

Type "# read it back — this is the API talking, not a local echo"
Enter
Type "clerk config pull --keys instance"
Sleep 500ms
Enter
Sleep 8s

Type "# several groups in one payload"
Enter
Type `clerk config patch --json '{"organization_settings":{"max_allowed_memberships":25},"protect":{"rules_enabled":true}}' --yes`
Sleep 700ms
Enter
Sleep 10s
Sleep 2s

# The same keyless application, driven the way an AI agent drives it:
# `--mode agent` turns every answer into JSON on stdout.

Output ../out/07-agent-mode.gif
Output ../out/07-agent-mode.mp4

Source "_common.tape"

Hide
Type "source ../lib/demo-env.sh && quiet_shell && new_project agent-mode && keyless_keys && clear" Enter
Show

Sleep 1s
Type "clerk --mode agent whoami"
Sleep 500ms
Enter
Sleep 7s

Type "clerk --mode agent config pull --keys organization_settings | jq '.organization_settings.enabled'"
Sleep 500ms
Enter
Sleep 7s

Type "clerk --mode agent enable orgs"
Sleep 500ms
Enter
Sleep 8s

Type "# and the failures are JSON too, so an agent can branch on them"
Enter
Type `clerk --mode agent config patch --json '{"nope":{}}'`
Sleep 500ms
Enter
Sleep 7s
Sleep 2s

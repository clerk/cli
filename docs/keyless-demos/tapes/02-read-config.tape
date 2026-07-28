# Read the instance configuration of an unclaimed keyless application.
# The only credential in play is the secret key already sitting in .env.local.

Output ../out/02-read-config.gif
Output ../out/02-read-config.mp4

Source "_common.tape"

Hide
Type "source ../lib/demo-env.sh && quiet_shell && new_project read-config && keyless_keys && clear" Enter
Show

Sleep 1s
Type "clerk config pull --keys protect"
Sleep 500ms
Enter
Sleep 8s

Type "# every readable group at once"
Enter
Type "clerk config pull | jq 'keys'"
Sleep 500ms
Enter
Sleep 8s

Type "clerk config pull --keys organization_settings | jq '.organization_settings | {enabled, max_allowed_memberships, domains_enabled}'"
Sleep 500ms
Enter
Sleep 9s
Sleep 2s

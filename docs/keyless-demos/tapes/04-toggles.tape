# Turn features on and off on an unclaimed keyless application.

Output ../out/04-toggles.gif
Output ../out/04-toggles.mp4

Source "_common.tape"

Hide
Type "source ../lib/demo-env.sh && quiet_shell && new_project toggles && keyless_keys && clear" Enter
Show

Sleep 1s
Type "clerk enable orgs"
Sleep 500ms
Enter
Sleep 8s

Type "# running it again is a no-op, not an error"
Enter
Type "clerk enable orgs"
Sleep 500ms
Enter
Sleep 7s

Type "clerk disable orgs"
Sleep 500ms
Enter
Sleep 8s
Sleep 2s

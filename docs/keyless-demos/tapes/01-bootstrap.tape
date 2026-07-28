# Bootstrap a Clerk application with no account, no browser, no login.

Output ../out/01-bootstrap.gif
Output ../out/01-bootstrap.mp4

Source "_common.tape"

Hide
Type "source ../lib/demo-env.sh && quiet_shell && new_project bootstrap && clear" Enter
Show

Sleep 1s
Type "clerk init --framework next --keyless --yes --no-skills"
Sleep 700ms
Enter
Sleep 30s

Type "clerk whoami"
Sleep 500ms
Enter
Sleep 8s
Sleep 2s

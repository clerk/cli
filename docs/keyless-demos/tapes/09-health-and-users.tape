# Everything else a keyless project should be able to do: check its own health,
# reach its own users, and find its way to the dashboard.
#
# Each of these used to fail on a perfectly working keyless application.

Output ../out/09-health-and-users.gif
Output ../out/09-health-and-users.mp4

Source "_common.tape"

Hide
# Bootstrapped through `clerk init` rather than by dropping keys in, so the
# project has the claim token init leaves behind — which is what `open` needs.
Type "source ../lib/demo-env.sh && quiet_shell && new_project health" Enter
Type "clerk init --framework next --keyless --yes --no-skills" Enter
Sleep 40s
Type "clear" Enter
Show

Sleep 1s
Type "clerk doctor"
Sleep 500ms
Enter
Sleep 14s

Type "clerk users list"
Sleep 500ms
Enter
Sleep 8s

Type `clerk open --print | sed -E 's/(token=)[^&]+/\1REDACTED/'`
Sleep 500ms
Enter
Sleep 8s
Sleep 2s

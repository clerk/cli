# Pre-configure the keyless application at creation time with --template.
# A b2b-saas app comes back with organizations already switched on.

Output ../out/05-templates.gif
Output ../out/05-templates.mp4

Source "_common.tape"

Hide
Type "source ../lib/demo-env.sh && quiet_shell && new_project templates && clear" Enter
Show

Sleep 1s
Type "clerk init --framework next --keyless --template b2b-saas --yes --no-skills"
Sleep 700ms
Enter
Sleep 32s

Type "# organizations were enabled before the first key was ever used"
Enter
Type "clerk config pull --keys organization_settings"
Sleep 500ms
Enter
Sleep 9s
Sleep 2s

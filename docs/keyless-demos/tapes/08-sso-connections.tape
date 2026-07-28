# Enterprise SSO on an unclaimed keyless application — add one, then remove it.
#
# Social providers (Google, GitHub) live only in the account-level config
# document, so they genuinely need a claimed app. Enterprise SSO connections do
# not: they are their own Backend API resource, and the instance's own secret
# key reaches them.

Output ../out/08-sso-connections.gif
Output ../out/08-sso-connections.mp4

Source "_common.tape"

Hide
Type "source ../lib/demo-env.sh && quiet_shell && new_project sso && keyless_keys && clear" Enter
Show

Sleep 1s
Type "clerk api ls enterprise"
Sleep 500ms
Enter
Sleep 7s

Type `clerk api /enterprise_connections -X POST --yes -d '{"name":"Acme Okta","domains":["acme.test"],"provider":"saml_custom"}' | jq '{id, name, provider, domains}'`
Sleep 700ms
Enter
Sleep 10s

Type "ID=$(clerk api /enterprise_connections | jq -r '.data[0].id') && echo $ID"
Sleep 500ms
Enter
Sleep 7s

Type "clerk api /enterprise_connections/$ID -X DELETE --yes"
Sleep 500ms
Enter
Sleep 8s
Sleep 2s

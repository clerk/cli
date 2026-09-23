# Established native Apple apps

Support depends on the operation's evidence, not the app's age. Existing custom
runtime configuration remains developer-owned. Selecting a Clerk app with
`--app` authorizes setup against that app; it does not prove which app a custom
runtime publishable key belongs to.

| Operation                                                | Required evidence                                                                                                                                                | Effect of uncertain custom startup wiring                                                                            |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Link SDK products                                        | Exhaustive target discovery, consistent platform views, complete source membership for product selection, and a safe package/project edit                        | May proceed when those prerequisites hold; preserve Swift                                                            |
| Register the native app during init                      | Explicit Clerk app selection for custom configuration, one Bundle ID across configurations/platforms, verified App ID Prefix, and additive remote reconciliation | May proceed when the local preflight and identity checks pass; does not verify runtime configuration                 |
| Doctor registration check                                | Linked Clerk app/development instance and independently verified target/platform identity; registration audit must resolve or report prefix ambiguity            | May run despite incomplete Swift membership; reports only Native API and registration state                          |
| Rewrite runtime configuration or insert prebuilt UI      | Proven runtime/source ownership and the relevant source plan's existing checks                                                                                   | Remains blocked; no parser expansion or inferred startup execution                                                   |
| Configure associated domains                             | Proven domain/key inputs and the capability planner's ownership checks                                                                                           | An unproven custom startup call does not supply a domain; preserve existing entitlements and report manual follow-up |
| Diagnose key matching, AuthView, or Apple authentication | The relevant runtime, source, entitlement, and linked-app evidence                                                                                               | Doctor's registration-only fallback does not run these checks or imply they passed                                   |

`init` still rejects incomplete source discovery before edits: its SDK choice and
combined local plan depend on that evidence. Doctor is read-only and can retain a
source-discovery failure while reporting an independently supported registration
result. Unresolved containers, target/platform selection, conflicting identities,
and divergent platform Swift setup remain blockers. The registration-only proof
is not an approved mutation plan.

The real-Xcode-derived [established app fixture](../test/fixtures/ios-established/README.md)
exercises partial integration and a rerun with existing package linkage and remote
registration. Its tests check both safe progress and preserved blockers. This is
a focused acceptance case, not a claim to understand arbitrary Swift startup code
or every mature Xcode project layout.

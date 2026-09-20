# Even G2 acceptance record

## Current flow

Install a compatible desktop build and Even App companion, enable Even G2 in CanvasTTY Controls, enter six digits and approve scoped device access on the computer. Local discovery uses eight reserved Bonjour names. No separately operated relay is required. The integration never changes the device's VPN or firewall settings.

## Reported physical acceptance

On 14 September 2026 the user confirmed connection, microphone input, terminal interaction and session creation on their Mac/Android/Even G2 setup. The subsequent More agents menu was also user-confirmed. These reports do not establish fresh-machine installation, detached-USB operation or background/reconnect behavior.

## Version 0.5.6 packaging correction

The 0.5.5 store review rejected a dynamic local URL template despite the intended hosts being listed in the manifest. Version 0.5.6 writes the eight origins as complete literals and validates emitted bundle URLs against the manifest before packing. The handoff records 622 desktop and 47 companion tests, type checks, builds, secret audit, and a negative control that rejects the former packaged frontend.

The corrected package was submitted for Even Hub review on 15 September 2026; approval is pending. A fresh 0.5.6 phone installation and physical voice run were not performed. The submitted package is immutable for this Git publication task.

## Integration with current upstream

Pi and OMP remain available in the desktop launcher and are included in the companion's provider lists and More agents picker. Their phone buttons and glasses selection routes are covered by the provider-enumerating tests. Source/CI results for this updated branch must be distinguished from the earlier submitted binary and hardware acceptance.

## Remaining acceptance

- Fresh phone install and complete pairing/voice flow for the next distributed artifact.
- Clean Mac installation; Intel Mac and other desktop platform device coverage.
- USB-detached operation, phone lock/background, reconnect and shutdown.
- Mixed-agent interactive acceptance for the newly added upstream providers.
- Device-specific transport key isolation and revocation semantics before broad distribution.
- Full browser navigation from glasses, which is outside the implemented terminal workflow.

See [the setup guide](even-g2.md) and [browser scope](even-g2-browser-voice-next.md).

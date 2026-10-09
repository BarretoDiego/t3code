# Install T3 Code Fork on Android

Download the `.apk` from the fork's [GitHub Releases](https://github.com/BarretoDiego/t3code/releases).
Open it on your phone and allow your browser or file manager to install apps when Android asks.
The app is named **T3 Code Fork** and can be installed alongside the original T3 Code app.

The APK includes the app and does not require Expo Go, a development server, a beta invitation,
or a time-limited installation. To update, install the APK from a newer release over the existing
app; this keeps your saved connections. Updates use the same signing key and an increasing
Android version code. The fork does not download the upstream app's Expo updates.

## Connect an environment

In the environment's T3 Code settings, open **Connections** and create a pairing code using a
network address your phone can reach. In the mobile app, add an environment with that address
and code. Repeat for each environment you want to control. For a Tailscale address, connect
your phone to the same tailnet first. `localhost` on your phone refers to your phone, not your
desktop server.

Pairing codes expire, but that does not expire the installed app. Saved connections remain
until removed or their access is revoked. Our V2 servers need a V2 mobile client; the original
V1 store app cannot connect to them.

Direct and Tailscale connections work without T3 Connect. Push notifications require the
separate T3 Connect integration described in [mobile notifications](mobile-notifications.md).

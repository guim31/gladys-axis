# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration holds and where:

- **Secrets**: the user names and passwords of the Axis devices live in the
  Gladys configuration of the integration (`secret` fields), never in `/data`,
  never in a log, an error message, a URL or an action result (the stream
  address action shows `PASSWORD` in their place).
- **`/data/axis-state.json`**: what each device is (serial number, model,
  video sources, ports, lights, clips, analytics scenarios) and the features
  learned from its events. Nothing secret.
- **Network**: only the configured devices are contacted, over HTTP or HTTPS
  (VAPIX, the WebSocket event stream) and RTSP (the metadata stream, older
  firmwares). The self-signed certificate of a device is accepted. The
  network search goes through Gladys (mediated mDNS and SSDP); the
  integration itself never scans the network. No cloud service.
- **Door stations**: the outputs (relays) may open a door; they are a scene
  action only, disabled until allowed in the configuration, sent once and
  never retried.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
and the Axis devices and their firmware.

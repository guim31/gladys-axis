# Axis for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) integration for **Axis**
network cameras, door stations (network intercoms) and network speakers,
**locally**, through their VAPIX API with digest authentication. No cloud
account, nothing leaves your network.

> **Developed without the hardware: feedback welcome.** No Axis device was
> available to write this integration: it was built from the public VAPIX
> documentation, the Home Assistant [`axis`](https://www.home-assistant.io/integrations/axis)
> integration, the [`axis`](https://github.com/Kane610/axis) library and the
> real device answers their tests quote, and is covered by tests against
> simulated devices. Please report what works and what does not in the
> [issues](https://github.com/guim31/gladys-axis/issues).

## Features

- **Cameras**: one Gladys device per video source (a multi-sensor camera has
  several). Image (refreshed on a timer, at each person and ring, and on
  demand), online, motion (AXIS Video Motion Detection, guard profiles, ONVIF
  motion rules), object analytics, person and vehicle (AXIS Object Analytics),
  PIR sensor, sound detection, tampering, night mode, each digital input —
  each one only when the device has it ("one sensor per event present": a
  detection seen in the events adds its feature).
- **Control**: the infrared light (on/off). The outputs (relays) are **never a
  switch**: on a door station they open the door, so they are a scene action
  only, **disabled by default**.
- **Door stations** (A8105-E, A8207-VE, I8016-LVE, I8116-E…): the ring of the
  call button, as the core `doorbell` feature.
- **Network speakers** (C1310-E, C1410…): online, and their audio clips played
  by a scene action.
- **Scene triggers**: _Person detected by a camera_ and _Someone rang the door
  station_. The camera image is refreshed in Gladys before the scene starts,
  so "send the camera image" sends the visitor.
- **Scene actions**: _Refresh a camera image_, _Play an audio clip_, _Drive an
  output (relay)_ (refused unless allowed in the configuration).
- **Dashboard widget** _Axis_: devices online, persons and rings of the last
  24 hours with their image, the state of each device.
- **Configuration actions**: _Test the connection_, _Search the network_ (the
  Axis devices found by mDNS and UPnP through Gladys), _Audio clips_, _Show the
  video stream address_ (the RTSP address for the "RTSP camera" integration of
  Gladys, never with the password).
- Four languages: English, French, German, Spanish.

## Requirements

- An Axis device reachable from Gladys, and a local account of it (operator
  role, or administrator). For the live events: AXIS OS 11 or later
  (WebSocket over the web port), or the RTSP port reachable (older
  firmwares).
- Gladys Assistant **5.1.0 or later**.

## Installation

1. In Gladys, open **Integrations** → **Install from GitHub** and enter the
   address of this repository: `https://github.com/guim31/gladys-axis` (or
   install **Axis** from the catalog once it is listed).
2. In **Configuration**, enter the addresses of your devices, the user name
   and the password (a second group for devices with other credentials),
   save, then click **Test the connection**. **Search the network** lists the
   Axis devices Gladys can see.
3. Open the **Discover** tab and add the devices.

The user guide is in [`docs/en.md`](docs/en.md) (also in
[French](docs/fr.md), [German](docs/de.md) and [Spanish](docs/es.md)); Gladys
links it from the Configuration screen.

## How it works

- **API**: VAPIX. `apidiscovery.cgi` (which JSON APIs exist),
  `basicdeviceinfo.cgi` or `param.cgi` (identity), `param.cgi` groups
  `Properties.Image`, `ImageSource`, `IOPort`, `MediaClip`, `Network.RTSP`,
  `io/portmanagement.cgi` or `io/port.cgi` (ports, outputs),
  `lightcontrol.cgi` (infrared light), `applications/list.cgi` and
  `/local/objectanalytics/control.cgi` (scenarios), `jpg/image.cgi`
  (snapshots), `mediaclip.cgi` (clips). HTTP digest (MD5, SHA-256) with
  node:http/https only.
- **Live events**: the WebSocket event stream (`/vapix/ws-data-stream`, a
  token from `wssession.cgi`, `events:configure`) when the device lists it,
  otherwise the RTSP metadata stream
  (`/axis-media/media.amp?video=0&audio=0&event=on`) with the RTP packets
  **interleaved in the RTSP TCP connection**: Home Assistant receives them
  over UDP, which never crosses the bridge network of a Gladys container.
  Small WebSocket and RTSP clients are written here, no dependency.
- **Passwords**: Axis devices block an address after repeated failures, so a
  password refused once is never tried again on its own: the device is left
  alone until the configuration changes or the user tests the connection.
- **Refresh**: devices are published with `should_poll: false`; the container
  reads the inputs and the infrared light every 5 minutes (every minute while
  an event stream is down) — Gladys never polls
  (GladysAssistant/Gladys#3198). States go through `publishChangedStates`:
  only the changes, plus a heartbeat every 6 hours.
- **Images**: Gladys takes 150 KB per camera image; the camera scales its
  snapshot itself (`resolution` and `compression` of `image.cgi`), 640 pixels
  wide at most, smaller once more if needed. No image decoding in the
  container.
- **Discovery**: mDNS `_axis-video._tcp` and SSDP
  `urn:axis-com:service:BasicService:1`, browsed by the core (mediated
  discovery) and read by the integration.
- **Persistence**: `/data/axis-state.json` keeps what each device is and the
  features learned from its events, so a device off at start keeps its
  features. Nothing secret.
- **Logs**: the lifecycle only at info level; a repeated failure is logged
  once, and once when it clears; `LOG_LEVEL=debug` shows the rest. Never a
  password.

## What could not be checked

No Axis device and no Gladys instance were available: the tests run against
the SDK's fake Gladys and simulated devices (`test/helpers/fakeAxis.js`)
built from the answers quoted by Home Assistant and Kane610/axis
(`test/fixtures/axis/`). Not checked for real:

- the WebSocket event stream: the subscription filter (`//.`, the one of
  Kane610/axis) and whether the device sends the current states at
  subscription (the integration does not count on it);
- the RTSP metadata stream over TCP interleaved (Home Assistant uses UDP);
- the call button of door stations other than the AXIS I8116-E: recognised
  by the name of its input only;
- the numbering of the ports in the events (taken equal to the port
  management API, as Home Assistant does);
- the answer of `mediaclip.cgi` and the outputs through `setStateSequence`;
- `https://` addresses (self-signed certificates accepted).

A read-only probe is provided for a real device:
`AXIS_PASSWORD=… node scripts/probe.mjs 192.168.1.90 [user] [seconds]`
prints the model, APIs, video sources, ports, lights, clips and scenarios,
takes a snapshot and listens to the events (`AXIS_EVENTS=rtsp` to force the
RTSP stream), without printing the password or the serial number. It changes
nothing on the device.

## Limitations

- No live video in Gladys (camera images), no PTZ, no recording, no two-way
  audio.
- The outputs are a scene action only, by design.
- The devices found by the network search are not added by themselves.
- The widget's event list is kept in memory.

## Development

```bash
npm ci
npm run format:check
npm run lint
npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

The tests use the fake Gladys of the SDK (`@gladysassistant/integration-sdk/testing`)
and simulated Axis devices (`test/helpers/fakeAxis.js`) that check the digest
authentication and speak VAPIX, the WebSocket event stream and RTSP. See
[`CLAUDE.md`](CLAUDE.md) for the project rules.

### Releasing

Describe each change under `## [Unreleased]` in
[`CHANGELOG.md`](CHANGELOG.md), then **Actions → Release → Run workflow**
(`patch`, `minor` or `major`): the workflow bumps the version everywhere, moves
the changelog section, tags, builds the multi-arch image to `ghcr.io` and
publishes the GitHub Release.

> A hand-pushed tag (`git tag v1.2.3 && git push --tags`) triggers the same
> build and Release, but does **not** bump anything: update `version` in
> `package.json` and in `gladys-assistant-integration.json` (with the
> `docker_image` tag) and commit it before tagging.

## Credits

- [Kane610/axis](https://github.com/Kane610/axis) (MIT, "Copyright (c) 2017
  Kane610"), the Python library of the Home Assistant integration: the VAPIX
  requests, the event topics and their meaning, the WebSocket event stream,
  and its real metadata documents, used as test fixtures
  (`test/fixtures/axis/metadata.json`). No code was copied; the protocol
  knowledge was rewritten in JavaScript.
- The Home Assistant [`axis`](https://github.com/home-assistant/core/tree/dev/homeassistant/components/axis)
  integration (Apache-2.0): the device answers of its tests (adapted and
  anonymised), the discovery services, the I8116-E call button rule.
- The architecture, the conformity tests and the quiet logs follow
  [gladys-dahua](https://github.com/guim31/gladys-dahua),
  [gladys-wled](https://github.com/guim31/gladys-wled) and
  [gladys-subsonic](https://github.com/guim31/gladys-subsonic); the digest
  authentication comes from [gladys-fritzbox](https://github.com/guim31/gladys-fritzbox).

## Disclaimer

This project is not affiliated with, endorsed or sponsored by Axis
Communications. AXIS is a trademark of Axis AB.

## License

Apache-2.0 — see [`LICENSE`](LICENSE).

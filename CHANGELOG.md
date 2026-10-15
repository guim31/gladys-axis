# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.1] - 2026-10-15

### Added

- Axis cameras, door stations and network speakers in Gladys, locally, over
  VAPIX with digest authentication: one device per video source.
- Camera images refreshed on a timer, at each person and ring, and on demand,
  scaled by the camera to fit Gladys.
- Live events over the WebSocket event stream (AXIS OS 11 and later) or the
  RTSP metadata stream: motion, object analytics, person, vehicle, PIR
  sensor, sound detection, tampering, night mode, digital inputs, the ring of
  a door station. A detection seen in the events adds its feature.
- The infrared light, on and off from Gladys.
- Scene triggers "Person detected by a camera" and "Someone rang the door
  station", with a fresh camera image.
- Scene actions "Refresh a camera image", "Play an audio clip" and "Drive an
  output (relay)", the last one disabled by default and never a switch.
- The "Axis" dashboard widget: devices online, persons and rings with their
  image.
- Configuration actions "Test the connection", "Search the network" (mDNS
  and UPnP through Gladys), "Audio clips" and "Show the video stream
  address".
- Documentation in English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-axis/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/guim31/gladys-axis/releases/tag/v1.0.1

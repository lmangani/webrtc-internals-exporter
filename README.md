# WebRTC Internals Exporter
A Chromium browser extension that allows to collect WebRTC stats and export them to a Prometheus PushGateway service.

## Install

### From sources
Run the `./build.sh` script and load the `build` folder as an unpacked extension
in your Chromium browser after enabling the developer mode.

### Using the packed extension (Linux only)
Download the `.crx` file from the [releases page](https://github.com/vpalmisano/webrtc-internals-exporter/releases) and drop it
into the [chrome://extensions/](chrome://extensions/) page.

Ref. https://developer.chrome.com/docs/extensions/mv3/hosting/

## Usage
1. Visit the extension options page, set the PushGateway URL and, optionally, the username and password.
2. Load the page where you want to collect the stats and click on the extension icon to enable the stats collection on that URL (disabled by default).
3. The stats will be collected and sent to the PushGateway service. You can use the provided [Grafana dashboard](https://github.com/vpalmisano/webrtc-internals-exporter/tree/main/grafana) to visualize them.

## Debugging
The extension logs are available in the browser console after setting:
```js
localStorage.setItem("webrtc-internal-exporter:debug", "true")
```

The running PeerConnections objects can be manually inspected using the following
command in the browser console:
```js
> webrtcInternalExporter.peerConnections
Map(1) {'b03c3616-3f91-42b5-85df-7dbebefae8bd' => RTCPeerConnection}
```

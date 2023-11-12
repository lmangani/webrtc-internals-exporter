/* global chrome, pako, base64 */

function log(...args) {
  console.log.apply(null, ["[webrtc-internal-exporter]", ...args]);
}

log("loaded");

import "/assets/pako.min.js";

const DEFAULT_OPTIONS = {
  url: "http://localhost:9091",
  username: "",
  password: "",
  updateInterval: 2,
  gzip: false,
  job: "webrtc-internals-exporter",
  enabledOrigins: {},
  enabledStats: ["inbound-rtp", "remote-inbound-rtp", "outbound-rtp"],
};

const options = {};

// Handle install/update.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  log("onInstalled", reason);
  if (reason === "install") {
    await chrome.storage.sync.set(DEFAULT_OPTIONS);
  } else if (reason === "update") {
    const options = await chrome.storage.sync.get();
    await chrome.storage.sync.set({
      ...DEFAULT_OPTIONS,
      ...options,
    });
  }

  await chrome.alarms.create("webrtc-internals-exporter-alarm", {
    delayInMinutes: 1,
    periodInMinutes: 1,
  });
});

async function updateTabInfo(tab) {
  const tabId = tab.id;
  const origin = new URL(tab.url || tab.pendingUrl).origin;

  if (options.enabledOrigins && options.enabledOrigins[origin] === true) {
    const { peerConnectionsPerOrigin } = await chrome.storage.local.get(
      "peerConnectionsPerOrigin",
    );
    const peerConnections =
      (peerConnectionsPerOrigin && peerConnectionsPerOrigin[origin]) || 0;

    chrome.action.setTitle({
      title: `WebRTC Internals Exporter\nActive Peer Connections: ${peerConnections}`,
      tabId,
    });
    chrome.action.setBadgeText({ text: `${peerConnections}`, tabId });
    chrome.action.setBadgeBackgroundColor({ color: "rgb(63, 81, 181)", tabId });
  } else {
    chrome.action.setTitle({
      title: `WebRTC Internals Exporter (disabled)`,
      tabId,
    });
    chrome.action.setBadgeText({ text: "", tabId });
  }
}

async function optionsUpdated() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  await updateTabInfo(tab);
}

chrome.storage.sync.get().then((ret) => {
  Object.assign(options, ret);
  log("options loaded");
  optionsUpdated();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;

  for (let [key, { newValue }] of Object.entries(changes)) {
    options[key] = newValue;
  }
  log("options changed");
  optionsUpdated();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  await updateTabInfo(tab);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  await updateTabInfo({ id: tabId, url: changeInfo.url });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "webrtc-internals-exporter-alarm") {
    cleanupPeerConnections().catch((err) => {
      log(`cleanup peer connections error: ${err.message}`);
    });
  }
});

async function setPeerConnectionLastUpdate({ id, origin }, lastUpdate = 0) {
  let { peerConnectionsLastUpdate } = await chrome.storage.local.get(
    "peerConnectionsLastUpdate",
  );
  if (!peerConnectionsLastUpdate) {
    peerConnectionsLastUpdate = {};
  }
  if (lastUpdate) {
    peerConnectionsLastUpdate[id] = { origin, lastUpdate };
  } else {
    delete peerConnectionsLastUpdate[id];
  }
  await chrome.storage.local.set({ peerConnectionsLastUpdate });

  const peerConnectionsPerOrigin = {};
  Object.values(peerConnectionsLastUpdate).forEach(({ origin: o }) => {
    if (!peerConnectionsPerOrigin[o]) {
      peerConnectionsPerOrigin[o] = 0;
    }
    peerConnectionsPerOrigin[o]++;
  });
  await chrome.storage.local.set({ peerConnectionsPerOrigin });
  await optionsUpdated();
}

async function cleanupPeerConnections() {
  let { peerConnectionsLastUpdate } = await chrome.storage.local.get(
    "peerConnectionsLastUpdate",
  );
  if (
    !peerConnectionsLastUpdate ||
    !Object.keys(peerConnectionsLastUpdate).length
  ) {
    return;
  }

  log(
    `checking stale peer connections (${
      Object.keys(peerConnectionsLastUpdate).length
    } total)`,
  );
  const now = Date.now();
  await Promise.allSettled(
    Object.entries(peerConnectionsLastUpdate)
      .map(([id, { origin, lastUpdate }]) => {
        if (
          now - lastUpdate >
          Math.max(2 * options.updateInterval, 30) * 1000
        ) {
          return { id, origin };
        }
      })
      .filter((ret) => !!ret?.id)
      .map(({ id, origin }) => {
        log(`removing stale peer connection metrics: ${id} ${origin}`);
        return sendData("DELETE", { id, origin });
      }),
  );
}

// Send data to pushgateway.
async function sendData(method, { id, origin }, data) {
  const { url, username, password, gzip, job } = options;
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (username && password) {
    headers.Authorization =
      "Basic " + base64.encode(`${username}:${password}}`);
  }
  if (data && gzip) {
    headers["Content-Encoding"] = "gzip";
    data = await pako.gzip(data);
  }
  /* console.log(
    `[webrtc-internals-exporter] sendData: ${data.length} bytes (gzip: ${gzip}) url: ${url} job: ${job}`,
  ); */
  const start = Date.now();
  const response = await fetch(
    `${url}/metrics/job/${job}/peerConnectionId/${id}`,
    {
      method,
      headers,
      body: method === "POST" ? data : undefined,
    },
  );

  const stats = await chrome.storage.local.get([
    "messagesSent",
    "bytesSent",
    "totalTime",
    "errors",
  ]);
  if (data) {
    stats.messagesSent = (stats.messagesSent || 0) + 1;
    stats.bytesSent = (stats.bytesSent || 0) + data.length;
    stats.totalTime = (stats.totalTime || 0) + Date.now() - start;
  }
  if (!response.ok) {
    const text = await response.text();
    stats.errors = (stats.errors || 0) + 1;
    throw new Error(`Response status: ${response.status} error: ${text}`);
  }
  await chrome.storage.local.set(stats);

  await setPeerConnectionLastUpdate(
    { id, origin },
    method === "POST" ? start : undefined,
  );

  return response.text();
}

const QualityLimitationReasons = {
  none: 0,
  bandwidth: 1,
  cpu: 2,
  other: 3,
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // log("message:", message);
  if (message.event === "peer-connection-stats") {
    // log("peer-connection-stats", message.data);
    const { url, id, state, values } = message.data;
    const origin = new URL(url).origin;

    if (state === "closed") {
      sendData("DELETE", { id, origin })
        .then(() => {
          sendResponse({});
        })
        .catch((err) => {
          sendResponse({ error: err.message });
        });
    } else {
      let data = "";
      const sentTypes = new Set();

      values.forEach((value) => {
        const type = value.type.replace(/-/g, "_");
        const labels = [`pageUrl="${url}"`];
        const metrics = [];

        if (value.type === "peer-connection") {
          labels.push(`state="${state}"`);
        }

        Object.entries(value).forEach(([key, v]) => {
          if (typeof v === "number") {
            metrics.push([key, v]);
          } else if (typeof v === "object") {
            Object.entries(v).forEach(([subkey, subv]) => {
              if (typeof subv === "number") {
                metrics.push([`${key}_${subkey}`, subv]);
              }
            });
          } else if (
            key === "qualityLimitationReason" &&
            QualityLimitationReasons[v] !== undefined
          ) {
            metrics.push([key, QualityLimitationReasons[v]]);
          } else if (key === "googTimingFrameInfo") {
            // TODO
          } else {
            labels.push(`${key}="${v}"`);
          }
        });

        metrics.forEach(([key, v]) => {
          const name = `${type}_${key.replace(/-/g, "_")}`;
          let typeDesc = "";

          if (!sentTypes.has(name)) {
            typeDesc = `# TYPE ${name} gauge\n`;
            sentTypes.add(name);
          }
          data += `${typeDesc}${name}{${labels.join(",")}} ${v}\n`;
        });
      });

      if (data.length > 0) {
        sendData("POST", { id, origin }, data + "\n")
          .then(() => {
            sendResponse({});
          })
          .catch((err) => {
            sendResponse({ error: err.message });
          });
      } else {
        sendResponse({});
      }
    }
  } else {
    sendResponse({ error: "unknown event" });
  }

  return true;
});

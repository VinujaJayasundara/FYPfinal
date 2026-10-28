/**
 * Ghost-Tracker — P2P WebSocket Relay Server
 * =============================================
 * A lightweight message relay that enables real device-to-device
 * synchronization over local Wi-Fi. This server does NOT store any
 * data — it simply forwards CRDT sync payloads between connected
 * Ghost-Tracker clients, preserving the P2P architecture.
 *
 * Usage:
 *   npm install ws          (one-time, from the GhostTrackerApp folder)
 *   node relay-server.js    (start the relay)
 *
 * Then on each phone's Sync tab, enter this machine's local IP
 * (printed to console on startup) and tap Connect.
 */

const { WebSocketServer } = require('ws');
const os = require('os');

const PORT = 8080;
const wss = new WebSocketServer({ port: PORT });

// Track connected clients
const clients = new Map(); // ws -> { deviceId, alias, connectedAt }

function broadcast(senderWs, message) {
  for (const [ws] of clients) {
    if (ws !== senderWs && ws.readyState === 1) {
      ws.send(message);
    }
  }
}

function broadcastPeerCount() {
  const count = clients.size;
  const msg = JSON.stringify({ type: 'PEER_COUNT', count });
  for (const [ws] of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

wss.on('connection', (ws) => {
  const connectedAt = new Date().toISOString();
  clients.set(ws, { deviceId: 'unknown', alias: 'unknown', connectedAt });

  console.log(`[${connectedAt}] 📱 New client connected (${clients.size} total)`);
  broadcastPeerCount();

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Registration message — client identifies itself
      if (msg.type === 'REGISTER') {
        clients.set(ws, {
          deviceId: msg.deviceId || 'unknown',
          alias: msg.alias || 'Runner',
          connectedAt,
        });
        console.log(`  ✅ Registered: ${msg.alias} (${msg.deviceId})`);

        // Notify other peers that someone joined
        const joinMsg = JSON.stringify({
          type: 'PEER_JOINED',
          deviceId: msg.deviceId,
          alias: msg.alias,
        });
        broadcast(ws, joinMsg);

        // Send the new client a list of all already-connected peers
        const peerList = [];
        for (const [otherWs, info] of clients) {
          if (otherWs !== ws && otherWs.readyState === 1 && info.deviceId !== 'unknown') {
            peerList.push({ deviceId: info.deviceId, alias: info.alias });
          }
        }
        ws.send(JSON.stringify({ type: 'PEER_LIST', peers: peerList }));

        broadcastPeerCount();
        return;
      }

      // Sync payload — relay to all other clients
      if (msg.type === 'SYNC_PAYLOAD') {
        const info = clients.get(ws);
        const sizeBytes = raw.length;
        console.log(`  📡 Relaying sync payload from ${info?.alias} (${sizeBytes} bytes) to ${clients.size - 1} peer(s)`);
        broadcast(ws, raw.toString());
        return;
      }

      // Live position — relay to all other clients (no logging to avoid spam)
      if (msg.type === 'LIVE_POSITION') {
        broadcast(ws, raw.toString());
        return;
      }

      console.log(`  ❓ Unknown message type: ${msg.type}`);
    } catch (e) {
      console.error('  ❌ Failed to parse message:', e.message);
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    clients.delete(ws);
    console.log(`[${new Date().toISOString()}] 📴 Client disconnected: ${info?.alias} (${clients.size} remaining)`);

    // Notify remaining peers
    if (info?.deviceId) {
      const leaveMsg = JSON.stringify({
        type: 'PEER_LEFT',
        deviceId: info.deviceId,
        alias: info.alias,
      });
      for (const [otherWs] of clients) {
        if (otherWs.readyState === 1) otherWs.send(leaveMsg);
      }
    }
    broadcastPeerCount();
  });

  ws.on('error', (err) => {
    console.error('  ❌ WebSocket error:', err.message);
  });
});

// ── Print startup info with local IP ──────────────────────

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

const localIP = getLocalIP();

console.log('');
console.log('═══════════════════════════════════════════════════════');
console.log('  👻 Ghost-Tracker P2P Relay Server');
console.log('═══════════════════════════════════════════════════════');
console.log(`  Status:   RUNNING`);
console.log(`  Port:     ${PORT}`);
console.log(`  Local IP: ${localIP}`);
console.log('');
console.log(`  📱 On each phone's Sync tab, enter:`);
console.log(`     ${localIP}:${PORT}`);
console.log('');
console.log('  Waiting for connections...');
console.log('═══════════════════════════════════════════════════════');
console.log('');

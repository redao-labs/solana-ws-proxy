import uWS from 'uWebSockets.js';
import { WebSocket as WsClient } from 'ws';
import dotenv from 'dotenv-safe';

dotenv.config();

const RPC_DOMAIN = process.env.SUBSCRIBE_DOMAIN as string; // e.g. "wss://..."
const WS_PROXY_PORT = Number(process.env.WS_PROXY_PORT) || 9010;

/** Store the local data we want to associate with each WebSocket. */
interface LocalClientData {
  proxyIds: Set<number>;
}

interface ProxyConnection {
  client: uWS.WebSocket<unknown>;
  client_id: number;
  proxy_id: number;
  server_id: number;
}

// A WeakMap to associate each connected ws with its LocalClientData
const localClientsMap = new WeakMap<uWS.WebSocket<unknown>, LocalClientData>();

let ws_client_lock = false;
let global_proxy_id = 0;
let ws_client: WsClient | null = null;

let proxy_client_connections = new Map<number, ProxyConnection>();
// Change the mapping so that each server subscription id maps to a Set of proxy IDs.
let server_proxy_subscriptions = new Map<number, Set<number>>();

function startNewWsProxy() {
  createNewWsClient();
  createNewWsServer();
}

function createNewWsClient() {
  if (ws_client) {
    try {
      ws_client.close();
    } catch (err) {
      // ignore
    }
    ws_client = null;
  }

  ws_client = new WsClient(RPC_DOMAIN);
  ws_client_lock = false;
  global_proxy_id = 0;
  proxy_client_connections = new Map();
  server_proxy_subscriptions = new Map();

  addListenersWsClient(ws_client);
}

function addListenersWsClient(client: WsClient) {
  client.on('open', () => {
    console.debug('Connected to RPC WebSocket node');
    ws_client_lock = true;

    const heartbeatInterval = setInterval(() => {
      const heartbeatMessage = JSON.stringify({
        jsonrpc: '2.0',
        method: 'ping',
      });
      client.send(heartbeatMessage);
      console.debug('Heartbeat message sent');
    }, 5000);

    client.on('close', () => {
      console.debug('RPC client connection closed');
      ws_client_lock = false;
      clearInterval(heartbeatInterval);
      setTimeout(startNewWsProxy, 500);
    });

    client.on('error', (err) => {
      console.error('RPC client connection error:', err);
      ws_client_lock = false;
      clearInterval(heartbeatInterval);
      setTimeout(startNewWsProxy, 3000);
    });

    client.on('message', (data: Buffer) => {
      const msgStr = data.toString();
      console.debug('Received from RPC:', msgStr);
      const msg = JSON.parse(msgStr);

      if ('id' in msg && 'result' in msg) {
        // Subscription registration response
        const server_subscription = msg.result;
        const proxy_id = msg.id as number;
        // Add the proxy_id to the set associated with this server subscription.
        if (!server_proxy_subscriptions.has(server_subscription)) {
          server_proxy_subscriptions.set(server_subscription, new Set());
        }
        server_proxy_subscriptions.get(server_subscription)!.add(proxy_id);

        const proxy = proxy_client_connections.get(proxy_id);
        if (!proxy) return;

        proxy.server_id = server_subscription;

        // Rewrite to local client's original fields.
        msg.id = proxy.client_id;
        msg.result = proxy.proxy_id;

        const outStr = JSON.stringify(msg);
        console.debug('Forward to local client:', outStr);
        proxy.client.send(outStr);
      } else if ('method' in msg && 'params' in msg) {
        // Subscription update
        const server_subscription = msg.params.subscription;
        const proxyIds = server_proxy_subscriptions.get(server_subscription);
        if (proxyIds !== undefined) {
          // Forward the update to every proxy connection for this subscription.
          for (const proxy_id of proxyIds) {
            const proxy = proxy_client_connections.get(proxy_id);
            if (!proxy) continue;

            // Clone the message so that each client gets its own subscription ID.
            const msgClone = JSON.parse(JSON.stringify(msg));
            msgClone.params.subscription = proxy.proxy_id;
            const outStr = JSON.stringify(msgClone);
            console.debug('Forward subscription update:', outStr);
            proxy.client.send(outStr);
          }
        }
      }
    });
  });
}

/**
 * Create the local uWebSockets.js server.
 */
function createNewWsServer() {
  const app = uWS.App({}).ws('/*', {
    open: (ws) => {
      // Initialize user data in the WeakMap
      localClientsMap.set(ws, { proxyIds: new Set<number>() });
      console.debug('New local WebSocket client connected.');
    },

    message: (ws, message, isBinary) => {
      try {
        const text = isBinary
          ? Buffer.from(message).toString()
          : new TextDecoder().decode(message);
        console.debug('Received from local client:', text);

        const client_data_json = JSON.parse(text);
        if ('params' in client_data_json && 'id' in client_data_json) {
          global_proxy_id++;
          const cur_proxy_id = global_proxy_id;

          // Retrieve the user data from the WeakMap.
          const userData = localClientsMap.get(ws);
          if (!userData) {
            console.error('No userData found for this client WebSocket');
            return;
          }

          userData.proxyIds.add(cur_proxy_id);

          if (cur_proxy_id >= Number.MAX_SAFE_INTEGER && ws_client) {
            ws_client.close();
          }

          const proxy_connection: ProxyConnection = {
            client: ws,
            client_id: client_data_json.id,
            proxy_id: cur_proxy_id,
            server_id: 0,
          };
          proxy_client_connections.set(cur_proxy_id, proxy_connection);

          client_data_json.id = cur_proxy_id;
          const outStr = JSON.stringify(client_data_json);
          console.debug('Forwarding to RPC node:', outStr);

          if (ws_client_lock && ws_client) {
            ws_client.send(outStr);
          }
        }
      } catch (err) {
        console.error('Failed to handle local client message:', err);
      }
    },

    close: (ws, code, message) => {
      console.debug('Local client disconnected. Cleaning up resources.');

      const userData = localClientsMap.get(ws);
      if (userData) {
        for (const proxy_id of userData.proxyIds) {
          const proxy_connection = proxy_client_connections.get(proxy_id);
          if (proxy_connection) {
            // Remove this proxy_id from its corresponding server subscription set.
            const subs = server_proxy_subscriptions.get(proxy_connection.server_id);
            if (subs) {
              subs.delete(proxy_id);
              if (subs.size === 0) {
                server_proxy_subscriptions.delete(proxy_connection.server_id);
              }
            }
            proxy_client_connections.delete(proxy_id);
          }
        }
      }
      // Remove the entry from the WeakMap.
      localClientsMap.delete(ws);
    },
  });

  app.listen(WS_PROXY_PORT, (token) => {
    if (token) {
      console.debug(`uWebSockets.js server listening on port ${WS_PROXY_PORT}`);
    } else {
      console.error(`Failed to listen on port ${WS_PROXY_PORT}`);
    }
  });
}

startNewWsProxy();

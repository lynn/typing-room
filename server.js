const WebSocket = require("websocket").server;
const http = require("http");

const server = http.createServer((request, response) => {
  response.writeHead(404);
  response.end();
});

const webSocketServer = new WebSocket({
  httpServer: server,
  autoAcceptConnections: false,
});

let cxs = new Map();
let buffers = new Map();

const broadcast = (x) => {
  for (const [k, v] of cxs.entries()) v.send(JSON.stringify(x));
};

webSocketServer.on("request", (request) => {
  if (!request.origin.includes(process.env.SPAT_ORIGIN)) {
    request.reject();
    return;
  }
  const connection = request.accept(null, request.origin);

  connection.on("message", (message) => {
    if (message.utf8Data.length > 5000) return;
    const msg = JSON.parse(message.utf8Data);
    if ("login" in msg) {
      cxs.set(msg.login, connection); broadcast({users: cxs.size});
      for (const [k, msg] of buffers.entries()) {
        connection.send(JSON.stringify(msg));
      }
    } else if ("text" in msg || "insert" in msg) {
      broadcast(msg);
      if (msg.submit) {
        console.log(`${new Date()} <\x1b[32m${msg.name}\x1b[0m> ${msg.text}`);
        buffers.delete(msg.login);
      }
      else buffers.set(msg.login, msg)
    } else if ("start" in msg) {
      broadcast(msg);
    }
  });

  connection.on("close", (reasonCode, description) => {
    cxs = new Map([...cxs].filter(([k, v]) => {
      if (v === connection) broadcast({ login: k, name: "", text: "" });
      return v !== connection;
    }));
    broadcast({users: cxs.size});
  });
});

server.listen(3434, "0.0.0.0", () => {
  console.log("WebSocket server is listening on port 3434");
});


const WebSocket = require("websocket").server;
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

let cxs = new Map();
const buffers = new Map();
let topic = "Typing room";
let last = undefined;

const routes = {
  "/": "client.html",
  "/client.html": "client.html",
  "/client.js": "client.js",
  "/send.wav": "send.wav",
};

const server = http.createServer((request, response) => {
  const url = request.url.split("?")[0];
  if (request.method === "GET" && routes[url]) {
    const filePath = path.join(__dirname, routes[url]);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        response.writeHead(500, { "Content-Type": "text/plain" });
        response.end("Internal Server Error");
      } else {
        response.writeHead(200, { "Content-Type":
          /\.wav$/.test(url) ? "audio/wav" :
          /\.js$/.test(url) ? "text/javascript;charset=UTF-8" : "text/html" });
        response.end(data); // .replaceAll(/1f307/g, (Math.random() * 256 + 0x1f300 | 0).toString(16)));
      }
    });
  } else if (request.method === "GET" && url === "/vrtnws") {
    https.get('https://www.vrt.be/vrtnws/_next/data/S1qALm8n-c22K82SZWsaL/nl.json', (externalResponse) => {
      let data = '';
      
      externalResponse.on('data', (chunk) => { data += chunk; });
      
      externalResponse.on('end', () => {
        response.writeHead(200, { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        response.end(data);
      });
    }).on('error', (error) => {
      console.error(`Error fetching VRT NWS data: ${error.message}`);
      response.writeHead(500, { 'Content-Type': 'text/plain' ,'Access-Control-Allow-Origin': '*' });
      response.end('Error fetching external data');
    });

  } else if (request.method === "GET" && url === "/count") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(cxs.size));
  } else if (request.method === "GET" && url === "/status") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ topic, count: cxs.size, last }));
  } else {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not Found");
  }
});

const webSocketServer = new WebSocket({
  httpServer: server,
  autoAcceptConnections: false,
});

const broadcast = (x) => {
  for (const [k, v] of cxs.entries()) v.send(JSON.stringify(x));
};

webSocketServer.on("request", (request) => {
  console.log(request.origin, process.env.SPAT_ORIGIN);
  if (!request.origin.includes(process.env.SPAT_ORIGIN)) {
    console.log("Nah");
    request.reject();
    return;
  }
  const connection = request.accept(null, request.origin);

  connection.on("message", (message) => {
    if (message.utf8Data.length > 5000) return;
    const msg = JSON.parse(message.utf8Data);
    if ("login" in msg) {
      cxs.set(msg.login, connection);
      broadcast({ users: cxs.size });
      for (const [k, msg] of buffers.entries()) {
        connection.send(JSON.stringify(msg));
      }
      connection.send(JSON.stringify({ topic }));
      if (last) connection.send(JSON.stringify({ ...last, now: +new Date() }));
    } else if ("text" in msg || "insert" in msg) {
      broadcast(msg);
      if (msg.submit) {
        last = { ...msg, submit: null, time: +new Date() };
        console.log(`${new Date()} <\x1b[32m${msg.name}\x1b[0m> ${msg.text}`);
        buffers.delete(msg.login);
      } else if ("text" in msg) {
        buffers.set(msg.login, msg);
      } else {
        const buffer = buffers.get(msg.login);
        if (buffer) buffer.text += msg.insert;
      }
    } else if ("topic" in msg) {
      console.log(msg);
      topic = msg.topic.substring(0, 100);
      broadcast({ id: msg.id, topic });
    } else if ("start" in msg) {
      broadcast(msg);
    }
  });

  connection.on("close", (reasonCode, description) => {
    cxs = new Map(
      [...cxs].filter(([k, v]) => {
        if (v === connection) broadcast({ login: k, name: "", text: "" });
        return v !== connection;
      }),
    );
    broadcast({ users: cxs.size });
  });
});

// console.log(process.argv);
const port = Number(process.argv[2] ?? 3434);
server.listen(port, "127.0.0.1", () => {
  console.log("WebSocket server is listening on port " + port);
});

const WebSocket = require("websocket").server;
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

type Login = number;

type Msg =
  // Login
  | { login: Login; room?: string; }
  // Complex edit
  | { id: Login; name: string; simple: boolean; hard: boolean; start: number; end: number; text: string; submit: boolean }
  // Insertion
  | { id: Login; name: string; simple: boolean; at: number; insert: string; }
  // Topic change
  | { id: Login; topic: string; }
  // Selection change
  | { id: Login; name: string; simple: boolean; start: number; end: number; }
  // User list
  | { users: string[] }

interface Cx { cx: WebSocket.connection; name: string; }

class Room {
  private logfile: fs.WriteStream;
  private buffers: Map<Login, Msg>;
  public cxs: Map<Login, Cx>;
  public topic: string = "Typing room";
  public last: Msg | undefined = undefined;
  constructor(name: string) {
    this.logfile = fs.createWriteStream(`room-${name}.log`, { flags: "a" });
    this.buffers = new Map();
    this.cxs = new Map();
  }

  public broadcast(x: Msg) {
    for (const [k, v] of this.cxs.entries()) v.cx.send(JSON.stringify(x));
  }

  public tellUsers() {
    this.broadcast({ users: [...this.cxs.values()].map(x => x.name) });
  }

  public handle(cx: WebSocket.connection, msg: Msg) {
    if ("login" in msg) {
      this.cxs.set(msg.login, { cx, name: "anon" });
      this.tellUsers();
      for (const [k, msg] of this.buffers.entries()) {
        cx.send(JSON.stringify(msg));
      }
      cx.send(JSON.stringify({ topic: this.topic }));
      if (this.last) cx.send(JSON.stringify({ ...this.last, now: +new Date() }));
    } else if ("text" in msg || "insert" in msg) {
      this.broadcast(msg);
      if (msg.submit) {
        this.last = { ...msg, submit: null, time: +new Date() };
        const c = this.cxs.get(msg.id);
        if (c) {
          if (c.name !== msg.name) {
            c.name = msg.name;
            this.tellUsers();
          }
        }
        const logline = `${new Date().toISOString()} <\x1b[32m${msg.name}\x1b[0m> ${msg.text}`
        console.log(logline);
        this.logfile.write(`${logline}\n`);
        this.buffers.delete(msg.login);
      } else if ("text" in msg) {
        this.buffers.set(msg.login, msg);
      } else {
        const buffer = this.buffers.get(msg.login);
        if (buffer) buffer.text += msg.insert;
      }
    } else if ("topic" in msg) {
      this.topic = msg.topic.substring(0, 100);
      this.broadcast({ id: msg.id, topic: this.topic });
    } else if ("start" in msg) {
      this.broadcast(msg);
    }
  }

  public leave(cx: WebSocket.connection) {
    this.cxs = new Map(
      [...this.cxs].filter(([k, v]) => {
        if (v.cx === cx) this.broadcast({ login: k, name: "", text: "" });
        return v.cx !== cx;
      }),
    );
    this.tellUsers();
  }
}

const routes = {
  "/": "client.html",
  "/client.html": "client.html",
  "/client.js": "client.js",
  "/simple.js": "simple.js",
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
        response.writeHead(200, {
          "Content-Type":
            /\.wav$/.test(url) ? "audio/wav" :
              /\.js$/.test(url) ? "text/javascript;charset=UTF-8" : "text/html"
        });
        response.end(data); // .replaceAll(/1f307/g, (Math.random() * 256 + 0x1f300 | 0).toString(16)));
      }
    });
  } else if (request.method === "GET" && url === "/vrtnws") {
    https.get('https://www.vrt.be/vrtnws/_next/data/u6iWbVYnh9kHIkeff4lxk/nl.json', (externalResponse) => {
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
      response.writeHead(500, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      response.end('Error fetching external data');
    });

  } else if (request.method === "GET" && url === "/count") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(rooms.get("main")?.cxs?.size));
  } else if (request.method === "GET" && url === "/status") {
    response.writeHead(200, { "Content-Type": "application/json" });
    const room = rooms.get("main")!;
    response.end(JSON.stringify({ topic: room.topic, count: room.cxs?.size, last: room.last }));
  } else {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not Found");
  }
});

const webSocketServer = new WebSocket({
  httpServer: server,
  autoAcceptConnections: false,
});

let rooms: Map<string, Room> = new Map();

rooms.set("main", new Room("main"));
if (process.env.TYPING_ROOMS) {
  for (const r of process.env.TYPING_ROOMS.split(",")) {
    rooms.set(r, new Room(r));
  }
}

webSocketServer.on("request", (request) => {
  console.log(request.origin, process.env.SPAT_ORIGIN);
  if (!request.origin.includes(process.env.SPAT_ORIGIN)) {
    console.log("rejecting", request.origin);
    request.reject();
    return;
  }
  const cx = request.accept(null, request.origin);

  cx.on("message", (message) => {
    if (message.utf8Data.length > 5000) return;
    const msg = JSON.parse(message.utf8Data);
    const roomName = msg.room ?? "main";
    const room = rooms.get(roomName);
    if (!room) { cx.close(); return; }
    room.handle(cx, msg);
  });

  cx.on("close", (reasonCode, description) => {
    for (const room of rooms.values()) room.leave(cx);
  });
});

const port = Number(process.argv[2] ?? 3434);
server.listen(port, "127.0.0.1", () => {
  console.log("WebSocket server is listening on port " + port);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", (line) => {
    try {
      const m = line.match(/^send (\w+) (.+)$/);
      if (m) {
        const room = rooms.get(m[1]);
        if (room) room.broadcast(JSON.parse(m[2]));
        else console.log("no such room");
      } else {
        console.log("?", line);
      }
    } catch (e) {
      console.log("!", e);
    }
  })
});

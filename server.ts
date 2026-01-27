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

interface Cx { cx: any; name: string; }

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

  public handle(cx: any, msg: Msg) {
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

  public leave(cx: any) {
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

let rooms: Map<string, Room> = new Map();

rooms.set("main", new Room("main"));
if (process.env.TYPING_ROOMS) {
  for (const r of process.env.TYPING_ROOMS.split(",")) {
    rooms.set(r, new Room(r));
  }
}

const port = Number(process.argv[2] ?? 3434);

const server = Bun.serve({
  port,
  hostname: "0.0.0.0",

  async fetch(req, server) {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const origin = req.headers.get("origin");

    // WebSocket upgrade
    if (pathname === "/chat") {
      // Check origin for WebSocket connections
      if (origin && process.env.SPAT_ORIGIN && !origin.includes(process.env.SPAT_ORIGIN)) {
        console.log("rejecting", origin);
        return new Response("Forbidden", { status: 403 });
      }

      const upgraded = server.upgrade(req);
      if (upgraded) {
        console.log("WebSocket upgrade successful");
        return undefined; // Return nothing when upgrade succeeds
      }
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // HTTP routes
    if (req.method === "GET" && routes[pathname]) {
      const filePath = path.join(__dirname, routes[pathname]);
      try {
        const file = Bun.file(filePath);
        const contentType =
          /\.wav$/.test(pathname) ? "audio/wav" :
          /\.js$/.test(pathname) ? "text/javascript;charset=UTF-8" : "text/html";
        return new Response(file, {
          headers: { "Content-Type": contentType }
        });
      } catch (err) {
        return new Response("Internal Server Error", { status: 500 });
      }
    } else if (req.method === "GET" && pathname === "/vrtnws") {
      try {
        const response = await fetch('https://www.vrt.be/vrtnws/_next/data/u6iWbVYnh9kHIkeff4lxk/nl.json');
        const data = await response.text();
        return new Response(data, {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          }
        });
      } catch (error) {
        console.error(`Error fetching VRT NWS data: ${error.message}`);
        return new Response('Error fetching external data', {
          status: 500,
          headers: {
            'Content-Type': 'text/plain',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    } else if (req.method === "GET" && pathname === "/count") {
      return new Response(JSON.stringify(rooms.get("main")?.cxs?.size), {
        headers: { "Content-Type": "application/json" }
      });
    } else if (req.method === "GET" && pathname === "/status") {
      const room = rooms.get("main")!;
      return new Response(JSON.stringify({ topic: room.topic, count: room.cxs?.size, last: room.last }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(ws) {
      console.log("WebSocket opened");
    },

    message(ws, message) {
      const data = typeof message === "string" ? message : new TextDecoder().decode(message);
      if (data.length > 5000) return;

      try {
        const msg = JSON.parse(data);
        const roomName = msg.room ?? "main";
        const room = rooms.get(roomName);
        if (!room) {
          ws.close();
          return;
        }
        room.handle(ws, msg);
      } catch (e) {
        console.error("Error handling message:", e);
      }
    },

    close(ws) {
      console.log("WebSocket closed");
      for (const room of rooms.values()) {
        room.leave(ws);
      }
    },
  }
});

console.log(`WebSocket server is listening on port ${port}`);

// Command line interface
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
});

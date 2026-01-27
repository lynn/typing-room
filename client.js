const η = (name, data = {}, children = []) => {
  const result = Object.assign(document.createElement(name), data);
  if (!Array.isArray(children)) children = [children];
  result.append(...children);
  return result;
};

const σ = (x) => document.querySelector(x);

let simpleOk = true;
const compose = σ(".compose input");
const messages = σ(".messages");
const isScrolledDown = () =>
  messages.scrollHeight - messages.clientHeight - messages.scrollTop < 10;
const stat = σ(".status");
const url = new URLSearchParams(location.search).get("s") || location.hostname;
const simple = !!new URLSearchParams(location.search).get("simple");
const hard = !!new URLSearchParams(location.search).get("hard");
const invisible = !!new URLSearchParams(location.search).get("invisible");
const small = !!new URLSearchParams(location.search).get("small");
const room = new URLSearchParams(location.search).get("room") ?? "main";
if (invisible) compose.className = "invisible";
if (invisible) σ(".name-input").classList.add("invisible");
let ws = null;
const buffers = {};
const id = Math.random();
let unread = 0;
let sendTimer = null;

function ser(msg) {
  const name = σ(".name-input").value;
  return JSON.stringify({ id, name, simple, small, hard, room, ...msg });
}

function ago(ms) {
  for (const [n, unit] of [[86400e3, "day"], [3600e3, "hour"], [60e3, "minute"], [1e3, "second"]]) {
    if (ms >= n) {
      const c = Math.floor(ms / n);
      return `${c} ${unit}${c === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

function divider(text) {
  return η("li", { className: "divider" }, [η("hr"), text, η("hr")]);
}

function reconnect() {
  if (!ws || ws.readyState === 3) {
    ws = new WebSocket(window.location.hostname === "localhost" ? `ws://localhost:3434/chat` : `wss://${url}/chat`);
    ws.onopen = () => {
      stat.innerHTML = "Connected";
      stat.className = "status connected";
      ws.send(JSON.stringify({ login: id, room }));
    };
    ws.onclose = () => {
      stat.innerHTML = "Reconnecting...";
      stat.className = "status disconnected";
    };
    ws.onerror = () => {
      stat.innerHTML = "Error";
      stat.className = "status disconnected";
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const scrolledDown = isScrolledDown();
      speaker = msg.name;
      if (msg.submit) {
        const own = msg.id === id;
        const li = η("li", { className: invisible && own ? "invisible" : msg.small ? "smaller" : "" });
        li.append(coloredName(msg.name), msg.text);
        beep(msg);
        if (document.hidden) document.title = `(${++unread}) Typing room`;
        window.linkifyElement?.(li, { target: "_blank" }, document);
        σ(".message-list").appendChild(li);
        buffers[msg.id] = null;
        if (scrolledDown) messages.scrollTo(0, messages.scrollHeight);
        renderBuffers();
      } else if (msg.users) {
        σ(".user-count").innerText =
          msg.users.length <= 1 ? "(nobody else here)" : `(${msg.users.length} users)`;
      } else if ("rename" in msg) {
        if (σ(".name-input").value === msg.rename) {
          σ(".name-input").value = msg.value;
          σ(".name-input").disabled = msg.disabled;
        }
      } else if ("topic" in msg) {
        if (msg.id !== id) σ("h1 input").value = msg.topic.replaceAll("\n", "");
      } else if ("time" in msg) {
        // last message
        const last = η("li", { className: msg.small ? "smaller" : "" });
        last.append(coloredName(msg.name), msg.text);
        last.className = "history";
        σ(".message-list").append(divider(ago(msg.now - msg.time)), last, divider("now"));
      } else if ("insert" in msg) {
        const k = msg.insert.length;
        buffers[msg.id] ??= { id: msg.id, name: msg.name, start: msg.at + k, end: msg.at + k, text: "" };
        if (/\S/u.test(msg.insert)) {
          beep(msg);
        }
        const old = buffers[msg.id].text;
        buffers[msg.id].text =
          old.slice(0, msg.at) + msg.insert + old.slice(msg.at);
        buffers[msg.id].start = msg.at + k;
        buffers[msg.id].end = msg.at + k;
        if (scrolledDown) messages.scrollTo(0, messages.scrollHeight);
        renderBuffers();
      } else if ("text" in msg) {
        const old = buffers[msg.id]?.text;
        buffers[msg.id] = msg;
        if (/\S/u.test(msg.text)) {
          beep(msg);
        }
        if (scrolledDown) messages.scrollTo(0, messages.scrollHeight);
        renderBuffers();
      } else if ("start" in msg) {
        const buffer = buffers[msg.id];
        if (buffer) {
          buffer.start = msg.start;
          buffer.end = msg.end;
        }
        if (scrolledDown) messages.scrollTo(0, messages.scrollHeight);
        renderBuffers();
      } else {
        console.warn("unrecognized", msg);
      }
    };
  }
}

setInterval(reconnect, 1000);
reconnect();

function nameHash(name) {
  if (name === "Robin") return 301;
  let deg = 0;
  for (const c of `${name}x`) deg = (223 * deg + c.charCodeAt(0)) % 360;
  return deg;
}

function coloredName(name, typing) {
  const deg = 110 + 0.85 * nameHash(name); // avoid ugly yellows
  const span = η("span", { className: "username" });
  const color = `color-mix(in oklch, oklch(65% 0.15 ${deg}), orange 25%)`;
  if (typing) {
    span.style.color = color;
    span.style.background = `transparent`;
  } else {
    span.style.background = color;
  }
  const langle = η("span", { className: "hidden" }, "<");
  const rangle = η("span", { className: "hidden" }, ">");
  span.append(langle, name, rangle);
  return span;
}

const ctx = new (window.AudioContext || window.webkitAudioContext)();
const flt = ctx.createBiquadFilter();
flt.type = "highshelf";
flt.frequency.value = 1200;
flt.gain.value = -10;
flt.connect(ctx.destination);
const real = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0]);
const imag = new Float32Array([0, 0.7, 0, 0.2, 0, 0, 0, 0]);
const mywave = ctx.createPeriodicWave(real, imag);
let speaker = "";

function playbeep(freq, wave, decay, bend, volume) {
  const time = ctx.currentTime;
  const osc = ctx.createOscillator();
  if (typeof wave === "string") osc.type = wave; else osc.setPeriodicWave(wave);
  osc.frequency.setValueAtTime(freq, time);

  let mod;
  if (osc.type === "sine") {
    const modgain = ctx.createGain();
    modgain.gain.value = 800;
    mod = ctx.createOscillator();
    modgain.connect(osc.detune);
    mod.connect(modgain);
    mod.frequency.setValueAtTime(freq, time);
    mod.start(time);
    mod.stop(time + 0.09);
  }
  osc.detune.setValueAtTime(0, time);
  if (bend) {
    osc.detune.linearRampToValueAtTime(bend, ctx.currentTime + 0.03);
    mod?.detune?.linearRampToValueAtTime(bend, ctx.currentTime + 0.03);
  }

  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(flt);
  gain.gain.setValueAtTime(volume, time);
  gain.gain.linearRampToValueAtTime(0, time + decay)
  osc.start(time);
  osc.stop(time + 0.09);
}

function beep(msg) {
  const name = msg.name;
  const c = msg.insert ?? (msg.text?.length === 1 ? msg.text : "a");
  const d = c.length;
  const steno = d >= 3 && !/^[\d\w]+$/.test(c);
  const submit = msg.submit;
  if (document.hidden && !document.title.includes("(")) document.title = `(*) Typing room`;
  if (!σ("#sound-input")?.checked) return;

  const h = nameHash(name);
  const wave = [mywave, "triangle", "square", "sine"][h % 4];
  const variance = h % 7 / 7 * 0.17;
  const randomize = steno ? 1 : Math.random() * variance + 1;
  let freq = (h / 360 + 0.6) * 300 * randomize * (msg.small ? 1.55 : 1);
  const mul = submit ? 2 : c === "!" ? 1.4 : /\p{L}/u.test(c) ? 1 : 0.6;
  const freqs = /^\d+$/.test(c) ? [...new Set([...c])].map((x) =>
    440 * [5/2, 1, 9/8, 5/4, 4/3, 3/2, 5/3, 15/8, 2, 9/4][+x]
  ) : [freq]; // steno ? [freq * [2/3, 3/4, 1, 9/8, 4/3][nameHash(c) % 5]] : [freq];
  const bend = c === "?" ? 600 : c === "!" ? -600 : 0;
  let decay = submit ? 0.025 : steno ? 0.06 : c === "?" || c === "!" ? 0.04 : 0.03;
  if (/\d/.test(c)) decay = 0.08;
  const volume = 0.1 / (freqs.length ** 0.5);
  const penta = [2/3, 3/4, 1, 9/8, 4/3];
  let i = nameHash(c);
  for (const f of freqs) {
    playbeep(f*mul*(steno?penta[i%5]:1), wave, decay, bend, volume);
    if (steno) setTimeout(() => playbeep(f*mul*penta[nameHash(c+",")%5], wave, decay, bend, volume / 3), 70);
  }
}

function renderBuffers() {
  const presenceList = σ(".presence-list");
  const scrolledDown = isScrolledDown();
  const children = [];
  for (const msg of Object.values(buffers).sort()) {
    const own = msg && msg.id === id;
    if (msg && msg.name && msg.text) {
      let msgText = msg.text;
      const name = σ(".name-input").value;
      if (msg.simple) {
        if (msg.name === name) simpleOk = true;
        msgText = msgText.replaceAll(
          /https?:\/\/\S+|:\w+:|[a-z\'\‘\’]+/gi,
          (m) => {
            if (!simpleRe.test(m)) {
              if (msg.name === name) simpleOk = false;
              return "•".repeat(m.length);
            } else return m;
          },
        );
      }
      const start = msg.start;
      const end = msg.end;
      const li = η("li", { className: invisible && own ? "invisible" : msg.small ? "smaller" : "" });
      li.append(
        coloredName(msg.name, true),
        msg.hard ? η("span", { className: "hard-marker" }, ["* "]) : "",
        msgText.slice(0, start)
      );
      const span = η("span");
      if (start === end) {
        span.innerText = msgText.slice(start);
        span.className = "cursor";
        li.append(span);
      } else {
        span.innerText = msgText.slice(start, end);
        span.className = "selected";
        const after = η("span");
        after.innerText = msgText.slice(end);
        li.append(span, after);
      }
      window.linkifyElement?.(li, { target: "_blank" }, document);
      children.push(li);
    }
  }
  presenceList.replaceChildren(...children);
  if (scrolledDown) messages.scrollTo(0, messages.scrollHeight);
}
function changeName() {
  const name = σ(".name-input").value;
  localStorage.setItem("name", name);
  compose.disabled = name === "";
  send(false);
}

let lastName = "";
let lastText = "";
let lastStart = 0;
let lastEnd = 0;

function sendPos(start, end) {
  if (lastStart === start && lastEnd === end) return;
  if (ws && ws.readyState === 1) {
    ws.send(ser({ id, name, simple, small, start, end }));
    lastStart = start;
    lastEnd = end;
  }
}
function send(submit) {
  sendTimer = null;
  chording = 0;
  if (submit && !simpleOk) return;
  if (ws && ws.readyState === 1) {
    const name = σ(".name-input").value;
    const start = compose.selectionStart;
    const end = compose.selectionEnd;
    const text = compose.value;
    if (!submit && lastName === name && lastText === text && lastStart === start && lastEnd === end)
      return;
    const k = text.length - lastText.length;
    if (k > 0 && name === lastName && start === end && !submit && text.slice(0, start - k) + text.slice(start) === lastText) {
      // this is an insertion
      const c = text.slice(start - k, start);
      ws.send(ser({ at: start - k, insert: c }));
    } else {
      ws.send(ser({ start, end, text, submit: text && submit }));
    }
    lastName = name;
    lastText = text;
    lastStart = start;
    lastEnd = end;
    if (text && submit) {
      compose.value = "";
      compose.focus();
      messages.scrollTo(0, messages.scrollHeight);
    }
  }
}
function setTopic(topic) {
  if (ws.readyState === 1) {
    ws.send(ser({ topic }));
  }
}

compose.addEventListener("keydown", (e) => {
  if (e.key === "Backspace" && hard) e.preventDefault();
  if (e.key === "Delete" && hard) e.preventDefault();
});

compose.addEventListener("keyup", (e) => {
  sendPos(compose.selectionStart, compose.selectionEnd);
  if (e.key === "Enter") send(true);
});

compose.addEventListener("mouseup", (e) => {
  setTimeout(() => sendPos(compose.selectionStart, compose.selectionEnd), 50);
});

compose.addEventListener("input", (e) => {
  if (sendTimer) chording += 1;
  clearTimeout(sendTimer);
  sendTimer = setTimeout(() => send(false), 20);
});

σ("h1 input").addEventListener("input", (e) => {
  setTopic(σ("h1 input").value);
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    unread = 0;
    document.title = "Typing room";
  }
});

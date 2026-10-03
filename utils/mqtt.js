/**
 * mqtt.js - 零依赖的 MQTT 3.1.1 over WebSocket 客户端
 * 适用于微信小程序（使用 wx.connectSocket）。
 *
 * 说明：
 *  - 小程序无法直连 MQTT TCP(1883)，必须通过 broker 的 WebSocket(WSS) 通道。
 *  - 本文件实现 MQTT 报文的打包/解析、连接、订阅、发布、心跳、自动重连。
 */

let mqttTask = null;      // wx SocketTask
let mqttHandler = null;   // 全局消息/状态回调
let status = 'unconnected'; // unconnected / connecting / connected / reconnecting
let options = null;
let keepAliveTimer = null; // 心跳定时器
let reconnectTimer = null;
let reconnectAttempts = 0;
let lastPing = 0;
let lastFatalReason = ''; // 最近一次「重连也没用」的拒绝原因（账密错误等），供 UI 提示与去重
let buffer = new Uint8Array(0); // 收包字节缓冲（处理粘包/拆包），用 Uint8Array 避免逐元素装箱
let _packetId = 1;
let _logSeq = 0;
// 调试日志：带时间戳，便于与 mosquitto 日志对齐定位
function log(tag, msg) {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  const ts = `${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  console.log(`[mq] #${_logSeq++} ${ts} ${tag} ${msg}`);
}

const subscribers = [];   // 本地路由表 { path, cb, qos }
const autoSubTopics = []; // 连接后需向 broker SUBSCRIBE 的 topic 列表

/* ================= 工具 ================= */

function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function Num(n) { return new Uint8Array([n & 0xff]); }
function Num2(n) { return new Uint8Array([(n >> 8) & 0xff, n & 0xff]); }

function utf8(s) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
  const b = unescape(encodeURIComponent(s));
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}
function decodeUtf8(u8) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(u8);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
}
function lenStr(s) {
  const b = utf8(s);
  return concat([Num2(b.length), b]);
}
function encodeLength(n) {
  const bytes = [];
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 0x80;
    bytes.push(d);
  } while (n > 0);
  return bytes;
}
function buildPacket(type, flags, bodyParts) {
  const body = concat(bodyParts);
  const header = [(type << 4) | (flags & 0x0f)];
  const len = encodeLength(body.length);
  return concat([new Uint8Array(header.concat(len)), body]);
}
function nextPacketId() { _packetId = (_packetId % 65534) + 1; return _packetId; }

/* ============ 报文构建 ============ */

function buildConnect(o) {
  const clientId = o.clientId || ('mqtt_wx_' + Math.random().toString(16).slice(2, 10) + (Date.now() % 10000));
  const keepalive = o.keepalive || 60;
  let flags = 0x02; // clean session
  if (o.username) flags |= 0x80;
  if (o.password) flags |= 0x40;

  const bodyParts = [
    lenStr('MQTT'), Num(4), Num(flags), Num2(keepalive),
    lenStr(clientId)
  ];
  if (o.username) bodyParts.push(lenStr(o.username));
  if (o.password) bodyParts.push(lenStr(o.password));

  return buildPacket(1 /* CONNECT */, 0, bodyParts);
}
function buildSubscribe(packetId, topics) {
  const parts = [Num2(packetId)];
  for (const t of topics) { parts.push(lenStr(t.topic)); parts.push(Num(t.qos || 0)); }
  return buildPacket(8 /* SUBSCRIBE */, 0x02, parts);
}
function buildPublish(topic, payload, qos, packetId) {
  const flags = (qos || 0) << 1;
  const parts = [lenStr(topic)];
  if (qos > 0) parts.push(Num2(packetId));
  parts.push(utf8(payload));
  return buildPacket(3 /* PUBLISH */, flags, parts);
}
function buildPubAck(packetId) { return buildPacket(4, 0, [Num2(packetId)]); }
function buildPing() { return new Uint8Array([0xc0, 0x00]); }
function buildDisconnect() { return new Uint8Array([0xe0, 0x00]); }

/* ============ 报文解析 ============ */

function tryParse(bytes) {
  const packets = [];
  let offset = 0;
  const len = bytes.length;
  while (offset < len) {
    if (offset + 1 > len) break;
    let remLen = 0, mult = 1, remBytes = 0, idx = offset + 1, ok = true;
    while (true) {
      if (idx >= len) { ok = false; break; }
      const en = bytes[idx++]; remBytes++;
      remLen += (en & 0x7f) * mult;
      if ((en & 0x80) === 0) break;
      if (remBytes > 4) { ok = false; break; }
      mult *= 128;
    }
    if (!ok) break;
    if (idx + remLen > len) break; // body 未完整
    packets.push({ type: bytes[offset] >> 4, flags: bytes[offset] & 0x0f, body: bytes.slice(idx, idx + remLen) });
    offset = idx + remLen;
  }
  return { packets, consumed: offset };
}

function handlePublish(flags, body) {
  if (body.length < 2) return;
  const tlen = (body[0] << 8) | body[1];
  const topic = decodeUtf8(body.slice(2, 2 + tlen));
  let pos = 2 + tlen;
  const qos = (flags >> 1) & 0x03;
  if (qos > 0 && pos + 2 <= body.length) {
    const packetId = (body[pos] << 8) | body[pos + 1];
    pos += 2;
    if (qos === 1 && mqttTask && status === 'connected') {
      try { mqttTask.send({ data: buildPubAck(packetId).buffer }); } catch (e) {}
    }
  }
  const payload = decodeUtf8(body.slice(pos));
  for (const s of subscribers) {
    if (matchTopic(s.path, topic)) {
      try { s.cb(topic, payload); } catch (e) { console.warn('订阅回调异常', e); }
    }
  }
  notify({ type: 'message', topic, payload });
}

function handlePacket(pkt) {
  switch (pkt.type) {
    case 2: { // CONNACK
      const rc = pkt.body.length > 1 ? pkt.body[1] : 1;
      if (rc === 0) {
        status = 'connected';
        lastPing = Date.now();
        lastFatalReason = ''; // 连上了，清掉此前的致命错误标记
        log('CONNACK', '成功 → connected');
        sendSubscribeNow();
        notify({ type: 'connected' });
        break;
      }
      // CONNACK 非 0 = 服务器拒绝（多为协议/账密错误），重连无意义，直接停止并上报原因
      const reasons = { 1: '协议版本不接受', 2: '客户端标识被拒', 3: '服务器不可用', 4: '用户名或密码错误', 5: '未授权' };
      const reason = reasons[rc] || ('错误码 ' + rc);
      log('CONNACK', 'FAIL rc=' + rc + ' ' + reason + ' → 停止重连');
      stopKeepAlive(); stopReconnect();
      status = 'unconnected';
      // 账密/授权类错误（4/5）不会因为重试而恢复，标记为致命，
      // 让 app.js 在后续任何触发点都不再反复重连（否则用户改完密码前的每次
      // onShow / 网络恢复都会重试一遍，既刷屏又白耗电）。
      if (rc === 4 || rc === 5) lastFatalReason = reason;
      if (mqttTask) { try { mqttTask.close({ code: 1000 }); } catch (e) {} }
      notify({ type: 'connack-error', reason, code: rc });
      break;
    }
    case 3: handlePublish(pkt.flags, pkt.body); break;
    case 9: // SUBACK
      log('SUBACK', '订阅确认');
      notify({ type: 'suback' });
      break;
    case 13: // PINGRESP
      lastPing = Date.now();
      log('PINGRESP', '收到心跳回复');
      break;
    default: break;
  }
}

function matchTopic(sub, topic) {
  const sp = sub.split('/');
  const tp = topic.split('/');
  for (let i = 0; i < sp.length; i++) {
    if (sp[i] === '#') return true;
    if (i >= tp.length) return false;
    if (sp[i] === '+') continue;
    if (sp[i] !== tp[i]) return false;
  }
  return sp.length === tp.length;
}

/* ============ 连接与生命周期 ============ */

function buildUrl(cfg) {
  let url = cfg.url || '';
  if (!/^(wss?|mqtt?s):\/\//i.test(url)) url = 'wss://' + url;
  url = url.replace(/^mqtts/i, 'wss').replace(/^mqtt/i, 'ws');
  const path = (cfg.path && cfg.path.trim()) ? cfg.path.trim() : '';
  // 仅当 url 无路径时追加 path
  const m = /^wss?:\/\/[^/]+(\/.*)?$/i.exec(url);
  if (m && !m[1] && path) url += (path === '/' ? '/' : (!path.startsWith('/') ? '/' + path : path));
  return url;
}

function onSocketData(data) {
  let u8;
  if (typeof data === 'string') u8 = utf8(data);
  else u8 = new Uint8Array(data);

  // 粘包/拆包：把新到字节追加到残留缓冲，用 Uint8Array 拼接（避免 Array.from 的逐元素装箱）
  let bytes;
  if (buffer.length === 0) {
    bytes = u8;
  } else {
    bytes = new Uint8Array(buffer.length + u8.length);
    bytes.set(buffer, 0);
    bytes.set(u8, buffer.length);
  }

  const { packets, consumed } = tryParse(bytes);
  // 只保留未消费完的尾部字节，供下次拼接
  buffer = consumed >= bytes.length ? new Uint8Array(0) : bytes.slice(consumed);

  for (const p of packets) handlePacket(p);
}

// 关闭当前 socket。关键：先解绑回调再 close，否则旧 socket 的 onClose/onError
// 会在新连接建立之后才异步触发，把 mqttTask 置空并对新连接误排一次重连。
function closeTask() {
  const t = mqttTask;
  mqttTask = null;
  if (!t) return;
  try {
    t.onClose(function () {});
    t.onError(function () {});
    t.onOpen(function () {});
    t.onMessage(function () {});
  } catch (e) {}
  try { t.close({ code: 1000 }); } catch (e) {}
}

// ⚠️ 生成一个连接代次号。所有 socket 回调（onOpen/onMessage/onError/onClose）
// 都闭包捕获创建自己那一代的 token，回调触发时先比对当前代次，不一致就直接丢弃。
// 这是为了防住这类竞态：closeTask() 虽然解绑了旧 socket 的回调，但 wx API 对
// 「已进入事件队列」的回调无法收回——旧 socket 的 onClose 仍可能在新连接建立后
// 才执行，从而把 mqttTask（此时指向新 socket）置空 + 对新连接误排一次重连，
// 表现为「刚连上就断开重连」的抖动。
let _connToken = 0;

// 状态变化统一入口：由 mqttHandler 的注册方（app.js）更新 globalData，
// 这里只负责回调，不重复维护一份 status。getStatus() 仍是唯一真实来源。
function notify(e) {
  if (mqttHandler) { try { mqttHandler(e); } catch (err) { console.warn('mqtt handler 异常', err); } }
}

function connect(cfg) {
  stopKeepAlive();
  stopReconnect();
  closeTask(); // 关闭旧任务并置空，避免 closeSocket:fail task not found
  const isUserInitiated = arguments.length > 1 && arguments[1];
  options = Object.assign({}, cfg);
  const prevStatus = status; // 先留存，否则日志里的「上一次状态」永远是刚赋的 connecting
  status = 'connecting';
  // 只有用户主动发起的连接才重置退避计数。自动重连走 connect(options, true)，
  // 必须保留计数，否则指数退避永远停在 4s（每次重连都被重置）。
  if (isUserInitiated) reconnectAttempts = 0;
  const url = buildUrl(options);
  const token = ++_connToken; // 本次连接的代次；旧 socket 的回调会因 token 不等而被丢弃

  log('CONNECT', '开始连接 url=' + url + ' (上一次状态=' + prevStatus + ')');
  try {
    mqttTask = wx.connectSocket({
      url,
      protocols: ['mqtt'], // 微信: 子协议参数名是 protocols（会带 Sec-WebSocket-Protocol: mqtt）
      timeout: 8000,
    });
    log('CONNECT', 'wx.connectSocket 已调用');
  } catch (e) {
    log('CONNECT', 'connectSocket 异常: ' + (e && e.errMsg));
    status = 'reconnecting';
    scheduleReconnect();
    return;
  }
  // 本代次的 socket；回调里一律用它而不是模块级 mqttTask，避免被子代次覆盖后误操作
  const task = mqttTask;
  const isStale = () => token !== _connToken;

  task.onOpen(() => {
    if (isStale()) { log('OPEN', '忽略过期连接回调'); return; }
    status = 'connecting';
    startKeepAlive();
    try { task.send({ data: buildConnect(options).buffer }); } catch (e) {}
    log('OPEN', 'socket 已打开，已发送 CONNECT 报文');
    notify({ type: 'connecting' });
  });

  task.onMessage((res) => { if (!isStale()) onSocketData(res.data); });

  // 注意：重连排程前必须 stopKeepAlive，否则旧的心跳定时器会残留。
  // startKeepAlive 内部会 stopKeepAlive（新版心跳覆盖旧版），但断线路径此前没人清，
  // 会出现「多个心跳定时器同时跑、同时判定连接死亡」的重复重连。
  task.onError((err) => {
    if (isStale()) { log('SOCK-ERR', '忽略过期连接回调'); return; }
    log('SOCK-ERR', JSON.stringify(err || {}));
    stopKeepAlive();
    if (status !== 'unconnected') { status = 'reconnecting'; mqttTask = null; scheduleReconnect(); }
  });

  task.onClose((res) => {
    if (isStale()) { log('SOCK-CLOSE', '忽略过期连接回调'); return; }
    log('SOCK-CLOSE', 'code=' + (res && res.code) + ' reason=' + (res && res.reason));
    stopKeepAlive();
    if (status !== 'unconnected') { status = 'reconnecting'; mqttTask = null; scheduleReconnect(); }
  });
}

function sendSubscribeNow() {
  if (!mqttTask) return;
  if (!autoSubTopics.length) return; // 无订阅项时别发空 SUBSCRIBE（部分 broker 会直接断开）
  const pkt = buildSubscribe(nextPacketId(), autoSubTopics.map(t => ({ topic: t, qos: 0 })));
  log('SUBSCRIBE', '发送 topics=' + JSON.stringify(autoSubTopics));
  try { mqttTask.send({ data: pkt.buffer }); } catch (e) {}
}

function startKeepAlive() {
  stopKeepAlive();
  lastPing = Date.now();
  keepAliveTimer = setInterval(() => {
    if (status !== 'connected' || !mqttTask) return;
    const keepaliveSec = (options && options.keepalive) || 60;
    const now = Date.now();
    const since = now - lastPing;
    // 超过一个 keepalive 周期无任何响应 => 连接已死，触发重连
    if (since >= keepaliveSec * 1000) {
      stopKeepAlive();
      status = 'reconnecting';
      log('KEEPALIVE', '超过 ' + Math.round(since / 1000) + 's 无响应 → 判定连接死亡');
      scheduleReconnect();
      return;
    }
    // 到半个周期主动发 PINGREQ，续命
    if (since >= (keepaliveSec / 2) * 1000) {
      try { mqttTask.send({ data: buildPing().buffer }); } catch (e) {}
      lastPing = now;
      log('PING send', '距上次心跳 ' + Math.round(since / 1000) + 's（keepalive=' + keepaliveSec + 's）');
    }
  }, 5000);
}
function stopKeepAlive() { if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; } }

function scheduleReconnect() {
  if (reconnectTimer || status === 'unconnected') return;
  reconnectAttempts++;
  const delay = Math.min(30000, 4000 * reconnectAttempts);
  log('RECONNECT', '第 ' + reconnectAttempts + ' 次，' + delay + 'ms 后重连');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(options, true); // true = 自动重连，保留退避计数
  }, delay);
}
function stopReconnect() { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } }

/* ============ 对外 API ============ */

function subscribe(path, cb, qos) {
  // 同一 path 多次 subscribe 会累积重复条目：handlePublish 里每条都会命中，
  // 同一个回调被调用 N 次。设备页反复 onLoad 时尤其明显（每次进出详情页都注册一遍）。
  const dup = subscribers.find((s) => s.path === path && s.cb === cb);
  if (dup) return;
  subscribers.push({ path, cb, qos: qos || 0 });
  if (!autoSubTopics.includes(path)) autoSubTopics.push(path);
  if (status === 'connected') sendSubscribeNow();
}
// 兼容别名
function onMessage(path, cb) { subscribe(path, cb); }
function setMqttHandler(fn) { mqttHandler = fn; }
function getStatus() { return status; }
function getFatalReason() { return lastFatalReason; }
function clearFatalReason() { lastFatalReason = ''; }

function publish(topic, payload, qos) {
  if (status !== 'connected' || !mqttTask) return false;
  const pkt = buildPublish(topic, String(payload), qos || 0, nextPacketId());
  try {
    mqttTask.send({ data: pkt.buffer });
  } catch (e) {
    // send 抛异常（socket 已进入关闭流程但 status 尚未同步）时不能返回 true，
    // 否则调用方会做乐观 UI 更新，出现「界面已切换、指令没发出去」的假成功。
    log('PUBLISH', 'send 异常: ' + (e && e.errMsg));
    return false;
  }
  return true;
}

function disconnect() {
  // 先把状态置为 unconnected，再做关闭动作：这样即便某个回调仍被触发，
  // 也会因为 status 已是 unconnected 而不会排重连。
  status = 'unconnected';
  stopKeepAlive(); stopReconnect();
  if (mqttTask) {
    try { mqttTask.send({ data: buildDisconnect().buffer }); } catch (e) {}
  }
  closeTask(); // 内部会解绑回调再 close，避免残留回调影响下一次连接
}

module.exports = {
  connect, disconnect, subscribe, onMessage, setMqttHandler, getStatus, publish,
  getFatalReason, clearFatalReason,
};
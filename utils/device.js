/**
 * device.js - 设备模型、存储、MQTT topic 生成、在线状态与消息路由。
 * 对照 Android 工程：DeviceClass 系列 + SQLiteClass(device_list) + MainApplication。
 */

const mqtt = require('./mqtt.js');

const STORAGE_KEY = 'device_list';

// 设备类型表（与 Android Device.TYPE_* 对应）
const TYPES = [
  { id: 0,  name: '按键伴侣 ButtonMate',    zone: 'buttonmate',  plug: 1 },
  { id: 1,  name: 'zTC1 智能排插',          zone: 'ztc1',        plug: 6 },
  { id: 2,  name: 'zDC1 智能排插',           zone: 'zdc1',        plug: 4 },
  { id: 3,  name: 'zA1 空气净化器',          zone: 'za1',         plug: 0 },
  { id: 4,  name: 'zM1 空气检测仪',          zone: 'zm1',         plug: 0 },
  { id: 5,  name: 'zS7 体重秤',              zone: 'zs7',         plug: 0 },
  { id: 6,  name: 'zClock 时钟',             zone: 'zclock',      plug: 0 },
  { id: 7,  name: 'zMOPS 插座',              zone: 'zmops',       plug: 4 },
  { id: 8,  name: 'zRGBW 灯',                zone: 'zrgbw',       plug: 0 },
  { id: 9,  name: 'zClock 点阵时钟',         zone: 'zclock_matrix', plug: 0 },
  { id: 10, name: 'zKey51 按键',             zone: 'zkey51',      plug: 0 },
  { id: 11, name: 'zC1 门窗传感器',          zone: 'zc1',         plug: 0 },
  { id: 12, name: 'z485ToMqtt',              zone: 'uarttomqtt',  plug: 0 },
  { id: 13, name: 'z863Key 墙壁开关',        zone: 'z863',        plug: 3 },
];

/* ---------- 设备列表（持久化） ---------- */
let list = [];
function loadStore() {
  try {
    const raw = wx.getStorageSync(STORAGE_KEY);
    // Storage 里可能是 null / 字符串 / 被写坏的对象。若不是数组直接回退为空表，
    // 否则后续 list.forEach / list.find 会在启动时抛异常导致整个 utils 加载失败。
    // 同时丢弃缺少 mac 的脏条目，避免 normalizeMac(undefined) 得到空串后拼出
    // `device//set` 这种非法 topic。
    const arr = (Array.isArray(raw) ? raw : []).filter((d) => d && typeof d === 'object' && normalizeMac(d.mac));
    list = [];
    const seen = new Set();
    for (const d of arr) {
      // 统一归一化 MAC：历史版本可能存了含大写/冒号的原始串，
      // 而路由过来的 e.mac 始终是归一化的，不统一会导致比对失败。
      const mac = normalizeMac(d.mac);
      // 去重：历史脏数据/并发写入可能产生同一 MAC 的多条记录，
      // 不去重会导致列表出现重复行、且改名/删除只作用到第一条。
      if (seen.has(mac)) continue;
      seen.add(mac);
      const typeId = typeAt(Number(d.type)) ? Number(d.type) : 0;
      list.push({
        mac,
        type: typeId,
        name: (d.name && String(d.name).trim()) || (typeAt(typeId) || {}).name || '未命名设备',
        sort: typeof d.sort === 'number' ? d.sort : list.length,
      });
    }
    // 按 sort 排序，保证列表顺序稳定（历史数据的 sort 可能乱序或缺省）
    list.sort((a, b) => a.sort - b.sort);
    // 重排一次 sort，消除并列/空洞，便于后续插入
    list.forEach((d, i) => { d.sort = i; });
  } catch (e) { list = []; }
}
function saveStore() {
  try { wx.setStorageSync(STORAGE_KEY, list); } catch (e) {}
}

/* ---------- 在线状态 & 事件 ---------- */
const onlineMap = {};       // mac -> true/false
const listeners = [];
function fire() { for (const cb of listeners) { try { cb(list); } catch (e) {} } }
function onChanged(cb) {
  listeners.push(cb);
  return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
}

/* ---------- 工具 ---------- */
function normalizeMac(mac) {
  return String(mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
}
function typeAt(id) { return TYPES.find(t => t.id === id) || null; }
function zoneFor(typeId) { return (typeAt(typeId) || {}).zone || ''; }
function plugCount(typeId) { return (typeAt(typeId) || {}).plug || 0; }

// 设备是否具备可用的收发条件（类型表里能找到 zone、且 MAC 非空）。
// 类型/ MAC 任一缺失都会拼出 `device//xxx/set` 这类非法 topic——
// broker 不会报错，但设备永远收不到，表现为「点了没反应」且极难排查。
function isRoutable(dev) {
  return !!(dev && zoneFor(dev.type) && normalizeMac(dev.mac));
}

/* ---------- MQTT topic ---------- */
// 发送控制指令 topic
function sendTopic(dev) {
  return 'device/' + zoneFor(dev.type) + '/' + normalizeMac(dev.mac) + '/set';
}
// 接收状态 topic
function recvTopics(dev) {
  const z = 'device/' + zoneFor(dev.type) + '/' + normalizeMac(dev.mac);
  return [z + '/state', z + '/sensor', z + '/availability'];
}

/* ---------- 连接后全量刷新(对齐安卓 MqttConnected) ---------- */
// wsm: 安卓在 MQTT 连接成功后(MqttConnected/ServiceConnected)会对每个设备发一条"全量状态查询"，
// 保证重连后列表状态及时更新。注意：此查询必须是纯查询，绝不能写入任何字段。
// 为了绝对安全，连接时间的查询与安卓原文逐字节一致（只有 mac/version/plug_N.on=null）,**不带 task_***。
//
// ⚠️ 关于定时任务读回（控制页打开弹窗时）：
//   本函数的 payload 会经由 `device/{zone}/{mac}/set` 下发，该 topic 是**读写共用**的，
//   固件无法从 topic 区分「查询」与「写入」，只能靠字段值判断。
//   因此所有读取意图都必须用 null 显式表达（与 plug_N.on=null 同构）。
//   切勿使用 `task_N:{}` 这种空对象：它不含任何字段，固件若按「收到 task_N 即解析写入」
//   实现，会把 hour/minute 读成 undefined 并可能写成 0，**覆盖用户已配置的定时任务**。
//
// ⚠️ 全插口一次性批量读回定时任务会害固件重启（现象=电源重启）：
//   若给每个插口都拼上 task_0~4（5×6 字段），6 口的 zTC1 会把这条查询压成 ~2.5KB、
//   4 口的 zDC1/MOPS 也有 ~1.7KB 的超大报文。`/set` 每次都该是几字节的增量小写，
//   这种体积对 ESP8266 的 MQTT 接收缓冲是过载的，固件解析出错→设备复位断电重启
//   →导致挂在排插上的主机一起几乎瞬间重启。因此定时任务**必须按单插口逐次读回**（
//   见 opts.plugId 只对对口携带 task 字段），绝不批量全读。
function requestState(dev, opts) {
  // 类型不在 TYPES 表内（或 MAC 为空）时 topic 会拼成 device//xxx/set，
  // 发出去也没有任何设备会响应，直接返回 false 让调用方走「未连接/无效」分支。
  if (!isRoutable(dev)) return false;
  const mac = normalizeMac(dev.mac);
  const plugs = plugCount(dev.type);
  // 默认(有连接/全局刷新)：与安卓 MqttConnected 一致，不携带任何 task 字段（报文最小且安全）。
  // 只有显式指定 opts.plugId 时，才只对该插口携带定时任务读回，其余插口仍只读 on/name。
  const taskPlug = (opts && Number.isInteger(opts.plugId) && opts.plugId >= 0 && opts.plugId < plugs)
    ? opts.plugId : -1;
  let payload = `{"mac":"${mac}","version":null`;
  for (let i = 0; i < plugs; i++) {
    if (i === taskPlug) {
      // 仅这一个插口携带定时任务读回；每个 task 字段显式置 null，与 plug_N.on=null 同构，
      // 确保对端只能理解为「读回」而非「写入」，且报文固定在「单插口」体积内。
      let setting = `"name":null`;
      for (let j = 0; j < 5; j++) {
        setting += `,"task_${j}":{"hour":null,"minute":null,"repeat":null,"action":null,"on":null}`;
      }
      payload += `,"plug_${i}":{"on":null,"setting":{${setting}}}`;
    } else {
      payload += `,"plug_${i}":{"on":null,"setting":{"name":null}}`;
    }
  }
  payload += '}';
  // 返回值：是否成功发出（未连接时 mqtt.publish 会静默返回 false，
  // 调用方（如控制页）可据此提示「未连接」，而不是静默什么都不发生。
  return mqtt.publish(sendTopic(dev), payload, 0);
}
// 向所有设备发一次全量查询。返回是否全部发出（任一失败即 false），
// 供列表页「刷新」按钮判断是否已连接。列表为空时视为成功。
function requestAllStates() {
  if (!list.length) return true;
  let ok = true;
  list.forEach((d) => { if (requestState(d) === false) ok = false; });
  return ok;
}

/* ---------- 消息路由 ---------- */
// 订阅到 device/# 下的任意主题都会被调用。
// ⚠️ 这里是全项目最热的一段代码：设备 sensor 帧可能每秒一帧 × 设备数。
// 正则放在函数外编译一次，避免每帧重新构造 RegExp（V8 有正则缓存，但显式提升更稳）。
const TOPIC_RE = /^device\/([^/]+)\/([0-9a-f]{6,})\/([^/]+)$/i;

function routeMessage(topic, payload) {
  // device/{zone}/{mac}/{kind}
  const m = TOPIC_RE.exec(topic);
  if (!m) return;
  const mac = m[2].toLowerCase();
  const kind = m[3].toLowerCase();
  if (kind === 'availability') {
    // 在线状态未变化时不再 setOnline：setOnline 内部会 fire()，
    // 而设备可能周期性重发 availability=1，无变化时广播会造成整表重绘。
    const on = payload.trim() === '1';
    const changed = isOnline(mac) !== on;
    if (changed) setOnline(mac, on);
    // availability 是「连接性信令」，不是设备状态数据，且列表页已通过 onChanged
    // 收到更新。仅在状态真的翻转时才推给 onMessage，避免重复帧让控制页多做一次
    // 无意义的 setData（控制页对 availability 的处理是一条独立的 setData({online})）。
    if (!changed) return;
  }
  // 触发 onMessage 事件，供控制页监听
  fireMessage({ mac, kind, zone: m[1].toLowerCase(), topic, payload });
}

/* ---------- 对外 API ---------- */
function getList() { return list; }
function getByMac(mac) {
  mac = normalizeMac(mac);
  if (!mac) return null;
  return list.find(d => normalizeMac(d.mac) === mac) || null;
}
function isOnline(mac) { return !!onlineMap[normalizeMac(mac)]; }
function setOnline(mac, on) {
  const m = normalizeMac(mac);
  if (!m) return;
  // 无变化直接返回：避免设备重复上报 availability 时反复 fire() 触发全表重绘
  if (!!onlineMap[m] === !!on) return;
  onlineMap[m] = !!on;
  fire();
}
function getOnlineValue() { return onlineMap; }

// 添加设备：只需 type + mac，不需要用户输入名字。
// 名字先兜底为设备类型名（如「zTC1 智能排插」），用户添加后可在列表页/详情页点击改名。
function add(type, name, mac) {
  mac = normalizeMac(mac);
  if (!mac) return { ok: false, msg: 'MAC 无效' };
  // 归一化后必须是 12 位 hex。宽松校验会放进「能添加但永远连不上」的脏 MAC。
  if (!/^[0-9a-f]{12}$/.test(mac)) return { ok: false, msg: 'MAC 需为 12 位十六进制' };
  if (!typeAt(Number(type))) return { ok: false, msg: '设备类型无效' };
  if (getByMac(mac)) return { ok: false, msg: '该设备已存在' };
  const typeId = Number(type);
  const typeName = (typeAt(typeId) || {}).name || '未知设备';
  const finalName = (name || '').trim() || typeName;
  const dev = { type: typeId, name: finalName, mac, sort: list.length };
  list.push(dev);
  saveStore();
  // 新设备在线时广播则在线状态保留
  fire();
  return { ok: true, dev };
}

// 修改设备名（仅本地存储，不下发设备）。
// 返回 { ok, msg }；名字为空时拒绝，避免列表出现空白行。
function rename(mac, name) {
  mac = normalizeMac(mac);
  const dev = getByMac(mac);
  if (!dev) return { ok: false, msg: '设备不存在' };
  const finalName = (name || '').trim();
  if (!finalName) return { ok: false, msg: '名称不能为空' };
  dev.name = finalName;
  saveStore();
  fire();
  return { ok: true, dev };
}

function remove(mac) {
  mac = normalizeMac(mac);
  if (!mac) return false;
  const i = list.findIndex(d => normalizeMac(d.mac) === mac);
  if (i >= 0) { list.splice(i, 1); saveStore(); fire(); }
  // 在线状态一并清掉：否则删掉设备后 onlineMap 里仍留着该项，
  // 用户重新添加同一 MAC 时会瞬间显示为「在线」（其实是上一次的残留值）。
  delete onlineMap[mac];
  return i >= 0;
}

// 批量清空。逐个 remove 会触发 N 次 fire()（进而 N 次 setData），
// 这里只落盘 + 广播一次。onlineMap 也一并清空，避免残留的在线状态被后续同名 MAC 复用。
function clearAll() {
  const n = list.length;
  list = [];
  saveStore();
  for (const k of Object.keys(onlineMap)) delete onlineMap[k];
  fire();
  return n;
}

function getTypes() { return TYPES; }

/* ---------- 初始化 ---------- */
loadStore();
let msgListeners = [];
function fireMessage(e) { for (const cb of msgListeners) { try { cb(e); } catch (err) {} } }
function onMessage(cb) { msgListeners.push(cb); return () => { const i = msgListeners.indexOf(cb); if (i >= 0) msgListeners.splice(i, 1); }; }

// 订阅所有设备 topic（device/# 覆盖所有 zone 的 state/sensor/availability）
mqtt.subscribe('device/#', (topic, payload) => routeMessage(topic, payload), 0);

module.exports = {
  TYPES,
  getTypes,
  getList,
  getByMac,
  add,
  rename,
  remove,
  clearAll,
  isOnline,
  setOnline,
  getOnlineValue,
  onChanged,
  onMessage,
  normalizeMac,
  typeAt,
  plugCount,
  isRoutable,
  sendTopic,
  recvTopics,
  requestState,
  requestAllStates,
  routeMessage,
};
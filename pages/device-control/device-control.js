// pages/device-control/device-control.js
const device = require('../../utils/device.js');
const mqtt = require('../../utils/mqtt.js');
const { statusText } = require('../../utils/status.js');

// —— 定时任务(zTC1/zDC1/zMOPS 等插口固件) ——
// 每插口最多 5 组 task_0~4，设备端存储，到点自动执行开关。
const WEEK = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const WEEK_SHORT = ['一', '二', '三', '四', '五', '六', '日'];
const TASK_SLOTS = 5;
const pad = (n) => (n < 10 ? '0' : '') + n;

function emptyTask() {
  return { hour: 0, minute: 0, repeat: 0, action: 1, on: 0 };
}
// 被删除/清空的定时任务：显式下发 action=0(关闭)、on=0、repeat=0、时间 00:00。
// 注意：绝不能复用 emptyTask() 的默认值——其 action 默认为 1(开启)，若固件按
// 「on=0 仅表示未启用，但仍读取时间/动作」解析，就会在每天 00:00 自动开启插口。
// 这里所有字段都取「无动作」语义，确保设备端将该槽位视为空任务。
function clearedTask() {
  return { hour: 0, minute: 0, repeat: 0, action: 0, on: 0 };
}
function repeatText(repeat) {
  repeat &= 0x7f;
  if (repeat === 0) return '仅一次';
  if (repeat === 0x7f) return '每天';
  const s = [];
  for (let i = 0; i < 7; i++) if (repeat & (1 << i)) s.push(WEEK[i]);
  return s.join('、');
}
// ⚠️ 类型契约（改动前务必先读）：
//   this.data 里的 task 对象走的是「视图层表示」，on 是 Boolean；
//   而设备端协议与下发 payload 里的 on 是 Number(0/1)。
//   taskView() 是布尔化转换的唯一入口，saveTask() 里做 Number(...) 回转。
//   任何绕过 taskView 直接往 data 里塞原始 task 对象的地方，都会让 switch
//   的 checked 拿到 0（虽为 falsy 但类型不对）或漏掉 timeText/actionText 派生字段。
function taskView(t) {
  t = t || emptyTask();
  return {
    ...t,
    on: t.on !== 0,
    timeText: pad(t.hour) + ':' + pad(t.minute),
    actionText: t.action !== 0 ? '开启' : '关闭',
    repeatText: repeatText(t.repeat),
  };
}
// repeat 由 week 数组(周一~周日，元素可为对象{on}或数字)计算：全 false = 不重复(0)，全 true = 每天(0x7f)
function buildRepeat(week) {
  let r = 0;
  for (let i = 0; i < 7; i++) {
    const w = week[i];
    const on = (typeof w === 'object' && w !== null) ? (w.on ? 1 : 0) : (w ? 1 : 0);
    if (on) r |= (1 << i);
  }
  return r;
}

Page({
  data: {
    mac: '',
    typeName: '',
    name: '',
    online: false,
    statusText: '未连接',
    plugs: [],
    allOn: false,
    anyOn: false,
    power: '',
    totalTime: '',
    version: '',

    // 定时任务弹窗
    hourRange: [],
    minuteRange: [],
    showTask: false,
    taskPlugId: -1,
    taskPlugName: '',
    taskSlots: [],
    selIdx: -1,
    editHour: 0,
    editMinute: 0,
    editAction: 1,
    editOn: 0,
    editHourText: '00',
    editMinuteText: '00',
    week: [
      { n: '一', on: 0 }, { n: '二', on: 0 }, { n: '三', on: 0 }, { n: '四', on: 0 },
      { n: '五', on: 0 }, { n: '六', on: 0 }, { n: '日', on: 0 },
    ],
  },

  onLoad(options) {
    const hourRange = [];
    const minuteRange = [];
    for (let h = 0; h < 24; h++) hourRange.push(pad(h));
    for (let m = 0; m < 60; m++) minuteRange.push(pad(m));
    this.setData({ hourRange, minuteRange });

    const mac = options.mac || '';
    const dev = device.getByMac(mac);
    if (!dev) {
      wx.showToast({ title: '设备不存在', icon: 'none' });
      wx.navigateBack();
      return;
    }
    const count = device.plugCount(dev.type);
    const plugs = [];
    for (let i = 0; i < count; i++) {
      const tasks = [];
      for (let j = 0; j < TASK_SLOTS; j++) tasks.push(emptyTask());
      plugs.push({ id: i, name: `插口${i + 1}`, on: false, tasks });
    }
    this.dev = dev;
    // 存归一化后的 MAC：device.js 路由过来的 e.mac 已归一化，若这里保留 options 原始串
    // （可能含大写/冒号），onDeviceMessage 的比对会永远不相等，导致整页收不到状态。
    const normMac = device.normalizeMac(dev.mac);
    this.setData({
      mac: normMac,
      name: dev.name || '',
      typeName: (device.typeAt(dev.type) || {}).name || '',
      plugs,
      statusText: statusText(mqtt.getStatus()),
    });

    this._unmsg = device.onMessage((e) => this.onDeviceMessage(e));
    this._unwatch = getApp().globalData.watchStatus((s) => {
      this.setData({ statusText: statusText(s) });
      if (s === 'connected') this.requestState();
    });
  },

  onShow() {
    this.refresh();
    // 已连接时主动请求一次状态（含插件开关/传感）
    if (mqtt.getStatus() === 'connected') this.requestState();
  },

  // 页面退到后台时注销状态监听：否则后台期间若 MQTT 重连成功，
  // watchStatus 的回调仍会打过来并触发 requestState()，产生无意义的网络流量。
  onHide() {
    if (this._unwatch) { this._unwatch(); this._unwatch = null; }
  },

  onUnload() {
    if (this._unmsg) { this._unmsg(); this._unmsg = null; }
    if (this._unwatch) { this._unwatch(); this._unwatch = null; }
    if (this._reqTimer) { clearTimeout(this._reqTimer); this._reqTimer = null; }
    if (this._syncTimer) { clearTimeout(this._syncTimer); this._syncTimer = null; }
    this._syncing = false;
    this._syncResolve = null;
  },

  refresh() {
    this.setData({
      online: device.isOnline(this.data.mac),
      statusText: statusText(mqtt.getStatus()),
    });
  },

  /* 下发状态请求(参照 Android MqttConnected /下拉刷新)
   * onLoad 的 watchStatus 会立即回调一次，onShow 也会请求一次，会导致短时间内
   * 连发两条全量查询。这里合并 300ms 内的重复请求，只发最后一条。 */
  requestState() {
    if (this._reqTimer) clearTimeout(this._reqTimer);
    this._reqTimer = setTimeout(() => {
      this._reqTimer = null;
      if (mqtt.getStatus() !== 'connected') return;
      // 控制页显式请求：普通状态查询（插口 on/name）。定时任务绝不在此批量读回——
      // 全插口带 task 字段会把 `/set` 压成 KB 级报文，固件解析会复位断电重启（电源重启）。
      const ok = device.requestState(this.dev);
      if (ok === false) {
        // publish 未连接时静默失败：此处给出一次轻提示，避免用户下拉后
        // 界面长时间停在旧数据却以为「已经刷新过了」。
        wx.showToast({ title: '未连接服务器，状态未刷新', icon: 'none', duration: 2000 });
      }
    }, 300);
  },

  // 手动刷新按钮：跳过 300ms 节流立刻发一次查询，并给出明确反馈。
  onManualRefresh() {
    if (this._reqTimer) { clearTimeout(this._reqTimer); this._reqTimer = null; }
    this.refresh();
    if (mqtt.getStatus() !== 'connected') {
      wx.showToast({ title: '未连接服务器，无法刷新', icon: 'none', duration: 2000 });
      return;
    }
    // 手动刷新：普通状态查询（插口on/name），不批量读回定时任务（见 requestState 注释）。
    const ok = device.requestState(this.dev);
    wx.showToast({
      title: ok === false ? '指令未发出，请检查连接' : '已请求最新状态',
      icon: 'none',
      duration: 1500,
    });
  },

  // 更改任何设置前先自动刷新一次：确保后续乐观更新的基线是最新设备状态，
  // 避免「界面显示的是旧值 → 用户基于旧值修改 → 覆盖设备上的新值」。
  // 返回 Promise：设备回包则立即放行；未连接则跳过；最多等 600ms（弱网兜底），
  // 保证按钮不会因为设备不回包而长时间无响应。
  syncBeforeChange() {
    if (this._syncing) return Promise.resolve(true);
    if (mqtt.getStatus() !== 'connected') return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this._syncing = false;
        this._syncResolve = null;
        if (this._syncTimer) { clearTimeout(this._syncTimer); this._syncTimer = null; }
        resolve(true);
      };
      this._syncing = true;
      this._syncResolve = finish;
      // 弱网兜底：设备不回包时最长等 600ms 就放行，避免按钮像卡死
      this._syncTimer = setTimeout(finish, 600);
      // 改前同步也只需普通状态：插口 on/name。定时任务已在 openTask 按单插口读回，
      // 保存/切换都以当口已回读的任务为准，无需全插口批量读而导致设备重启。
      const ok = device.requestState(this.dev);
      // 指令根本没发出去（连接在 check 之后断掉了）：立即放行，让调用方走
      // publishOrWarn 的失败分支给出正确提示，而不是白等 600ms。
      if (ok === false) finish();
    });
  },

  // 改名（仅本地，不下发设备）。设备名归用户所有，固件上报的 name 不覆盖它。
  renameDevice() {
    const cur = this.data.name || '';
    wx.showModal({
      title: '修改设备名称',
      editable: true,
      placeholderText: '请输入名称',
      content: cur,
      success: (res) => {
        if (!res.confirm) return;
        const name = (res.content || '').trim();
        const r = device.rename(this.data.mac, name);
        if (!r.ok) {
          wx.showToast({ title: r.msg || '修改失败', icon: 'none' });
          return;
        }
        this.setData({ name: r.dev.name });
      },
    });
  },
  onTitleTap() { this.renameDevice(); },

  onDeviceMessage(e) {
    if (e.mac !== device.normalizeMac(this.data.mac)) return;

    if (e.kind === 'availability') {
      this.setData({ online: e.payload.trim() === '1' });
      return;
    }
    this.parseState(e.payload);
  },

  // 判定某帧里的 task_j 是否是一个「完整的任务对象」。
  // 固件在只回读部分字段时可能给出 null 或缺字段，缺任一字段都不应写入，
  // 否则会把设备上已有的定时任务覆盖成残缺值。
  _isFullTask(tk) {
    return !!tk && typeof tk === 'object' &&
      typeof tk.hour === 'number' && typeof tk.minute === 'number' &&
      typeof tk.repeat === 'number' && typeof tk.action === 'number' &&
      typeof tk.on === 'number';
  },

  // 设备主动上报串口是高频的（如 sensor 每秒一帧），这里把多次 setData 合并为一次，
  // 只在字段确实变化时才提交，减少 Skyline 下 JS→渲染线程 的跨线程通信量。
  parseState(payload) {
    let json;
    try { json = JSON.parse(payload); } catch (err) { return; }

    const patch = {};

    // 注意：不使用 json.name 覆盖 data.name。
    // data.name 是用户在本机起的设备名（存本地 Storage），json.name 是设备固件上报的名字，
    // 二者语义不同——若在此覆盖，用户改的名字会被设备出厂名冲掉。
    // 设备名只在用户主动改名时变化，见 renameDevice()。
    if (json.power !== undefined) {
      const p = this.formatPower(json.power);
      if (p !== this.data.power) patch.power = p;
    }
    if (json.total_time !== undefined) {
      const t = this.formatTime(json.total_time);
      if (t !== this.data.totalTime) patch.totalTime = t;
    }
    if (json.version && json.version !== this.data.version) patch.version = json.version;

    // 插口状态 plug_N.on / plug_N.setting.name / plug_N.setting.task_j
    const plugs = this.data.plugs.slice();
    let plugsDirty = false;
    // 本帧是否含有插口字段。用于区分「查询应答」与「高频 sensor 上报」：
    // 只有前者才代表我们等的那次同步已完成（见函数末尾的 _syncResolve）。
    let hadPlugFields = false;
    for (let i = 0; i < plugs.length; i++) {
      const p = json['plug_' + i];
      if (!p) continue;
      hadPlugFields = true;

      // 先算出本插口的「目标值」，全部就绪后再与现值整体比对。
      // 原实现把两次 task 遍历（探测变化 + 写入）分开，既重复解析又容易漏判；
      // 这里合并为一轮，先把 nextTasks 组装好，再统一比对/提交。
      let nextOn = plugs[i].on;
      let nextName = plugs[i].name;
      const nextTasks = plugs[i].tasks || [];

      if (p.on !== undefined && p.on !== null) {
        const on = (typeof p.on === 'string') ? (p.on !== '' && p.on !== '0') : !!p.on;
        nextOn = on;
      }
      if (p.setting && p.setting.name) nextName = p.setting.name;

      let tasksChanged = false;
      const mergedTasks = new Array(TASK_SLOTS);
      for (let j = 0; j < TASK_SLOTS; j++) {
        const tk = p.setting ? p.setting['task_' + j] : undefined;
        if (this._isFullTask(tk)) {
          const cur = nextTasks[j];
          const next = { hour: tk.hour, minute: tk.minute, repeat: tk.repeat, action: tk.action, on: tk.on };
          if (!cur || cur.hour !== next.hour || cur.minute !== next.minute ||
              cur.repeat !== next.repeat || cur.action !== next.action || cur.on !== next.on) {
            tasksChanged = true;
          }
          mergedTasks[j] = next;
        } else {
          mergedTasks[j] = nextTasks[j] || emptyTask();
        }
      }

      const ioChanged = nextOn !== plugs[i].on || nextName !== plugs[i].name;
      if (!ioChanged && !tasksChanged) continue;

      // 确认有变化后才克隆该插口，再把新值写入副本（不触碰 this.data 内的原对象）
      plugs[i] = this.clonePlug(plugs, i);
      plugs[i].on = nextOn;
      plugs[i].name = nextName;
      if (tasksChanged) plugs[i].tasks = mergedTasks;
      plugsDirty = true;
    }

    if (plugsDirty) {
      patch.plugs = plugs;
      // allOn/anyOn 随插口变化一并计算，保证总开关显示与逐口状态一致
      patch.allOn = plugs.length > 0 && plugs.every((p) => p.on);
      patch.anyOn = plugs.length > 0 && plugs.some((p) => p.on);

      // 定时任务弹窗打开时，顺带刷新弹窗内容，避免用户对着打开那一刻的旧快照编辑，
      // 保存后把设备上的新数据覆盖掉。仅在用户未在编辑某条任务时刷新（selIdx < 0），
      // 否则会打断正在填写的表单。
      if (this.data.showTask && this.data.selIdx < 0 && this.data.taskPlugId >= 0) {
        // 用本次刚算出的 plugs（而非 this.data.plugs）取任务，确保弹窗拿到的是最新值
        const popen = plugs[this.data.taskPlugId];
        if (popen && popen.tasks) {
          const slots = [];
          for (let j = 0; j < TASK_SLOTS; j++) slots.push(taskView((popen.tasks || [])[j]));
          patch.taskSlots = slots;
        }
      }
    }

    if (Object.keys(patch).length) this.setData(patch);

    // 若正处于「改前同步」等待中，收到设备回包即放行，不必等满 600ms 兜底超时。
    // ⚠️ 只有当本次回包真的携带了插口/定时任务字段（即确实是查询的应答）才放行。
    // 设备会高频上报 sensor 帧（每秒一帧，只含 power/total_time），若不加这个判断，
    // sensor 帧一到就会提前放行，导致「改前刷新」形同虚设。
    if (this._syncResolve && hadPlugFields) this._syncResolve();
  },

  // 依据插口状态计算两个派生字段：
  //   anyOn = 任一插口通电 → 总开关显示「开」（点击则关闭全部）
  //   allOn = 全部插口通电 → 仅用于文案「全部开启 / 部分开启」的区分
  applyPlugs(plugs) {
    const allOn = plugs.length > 0 && plugs.every((p) => p.on);
    const anyOn = plugs.length > 0 && plugs.some((p) => p.on);
    this.setData({ plugs, allOn, anyOn });
  },

  // 功率展示。固件在异常或启动瞬间可能给出非数值（如 "abc"、undefined），
  // 直接拼接会渲染成 "NaN W"，这里统一兜底为占位符。
  formatPower(p) {
    if (p === -1) return 'ERROR';
    const n = Number(p);
    if (!isFinite(n)) return '-- W';
    return n + ' W';
  },
  formatTime(t) {
    if (t === undefined || t === null) return '';
    if (t === 0 || t === '0') return '0';
    let s = '';
    const d = Math.floor(t / 86400);
    const h = Math.floor((t % 86400) / 3600);
    const m = Math.floor((t % 3600) / 60);
    const sec = Math.floor(t % 60);
    if (d > 0) s += d + '天';
    if (h > 0) s += h + '小时';
    if (m > 0) s += m + '分';
    if (s === '' && sec > 0) s += sec + '秒';
    return s || '0';
  },

  // 拷贝单个插口（含 tasks），避免直接改动 this.data 里的对象。
  // 注意：this.data.plugs.slice() 是浅拷贝，plugs[i] 仍指向同一对象，
  // 直接赋值会绕过 setData 提前污染 this.data，后续若读取将拿到未提交的数据。
  clonePlug(plugs, i) {
    const p = plugs[i];
    if (!p) return { id: i, name: '', on: false, tasks: [] };
    return Object.assign({}, p, { tasks: (p.tasks || []).map((t) => Object.assign({}, t)) });
  },

  // 统一的下发入口：mqtt.publish 在未连接时会静默返回 false，
  // 若不做校验就乐观更新 UI，会出现「界面已切换、指令实际未发出」的假成功——
  // 对断电类操作尤其危险。此处集中拦截，失败时给出提示并告知调用方。
  publishOrWarn(topic, payload) {
    // 主题合法性兜底：设备类型未知时 zone 为空，topic 会变成 `device//mac/set`。
    // broker 不会报错但设备永远收不到，直接拦下并给出明确提示。
    if (!topic || /^device\/\/|^device\/[^/]*\/\//.test(topic)) {
      wx.showToast({ title: '设备类型异常，无法下发指令', icon: 'none', duration: 2500 });
      return false;
    }
    if (!mqtt.publish(topic, payload, 0)) {
      wx.showToast({ title: '未连接服务器，指令未发送', icon: 'none', duration: 2500 });
      return false;
    }
    return true;
  },

  onPlugChange(e) {
    const id = Number(e.currentTarget.dataset.id);
    const on = !!e.detail.value; // switch 开启与否
    // 越界保护：dataset 缺失时 Number(undefined)=NaN，后续读 plugs[NaN].name 会抛异常
    if (!Number.isInteger(id) || id < 0 || id >= this.data.plugs.length) return;
    // 用户取消关闭时，switch 已停在 off，需回滚到真实状态
    const rollback = () => {
      const plugs = this.data.plugs.slice();
      plugs[id] = this.clonePlug(plugs, id);
      this.applyPlugs(plugs);
    };
    const confirm = (fn) => {
      wx.showModal({
        title: '关闭插口',
        content: `确定要关闭「${this.data.plugs[id].name}」吗？关闭将切断该插口供电。`,
        confirmColor: '#fa5151',
        success: (res) => { if (res.confirm) fn(); else rollback(); },
        fail: rollback,
      });
    };
    const doPublish = () => {
      // 下发前先同步一次设备最新状态（见 syncBeforeChange）。
      // 若期间设备状态已被别处改变，plugs 会被刷新，用户即将写入的目标仍以用户意图为准，
      // 但其余插口/定时任务显示的是最新值，不会把旧快照当成基线。
      this.syncBeforeChange().then(() => {
        const payload = { mac: device.normalizeMac(this.dev.mac), ['plug_' + id]: { on: on ? 1 : 0 } };
        if (!this.publishOrWarn(device.sendTopic(this.dev), JSON.stringify(payload))) {
          // 下发失败：switch 已被用户拖动，回滚到真实状态，避免「假成功」
          rollback();
          return;
        }
        // 乐观更新 UI
        const plugs = this.data.plugs.slice();
        plugs[id] = this.clonePlug(plugs, id);
        plugs[id].on = on;
        this.applyPlugs(plugs);
      });
    };
    if (!on) confirm(doPublish);
    else doPublish();
  },

  // 总开关语义：只要有任一插口通电，总开关即显示「开」。
  //   全关   → 点击 = 全部打开
  //   部分开 → 点击 = 关闭全部（即关掉已通电的那部分）
  //   全开   → 点击 = 关闭全部
  // 因此 switch 的 checked 绑定 anyOn（而非 allOn），拖动方向天然与上述语义一致：
  // anyOn=true 时拖动只能得到 value=false（走全关），anyOn=false 时只能得到 value=true（走全开）。
  onAllChange(e) {
    const on = e.detail.value ? 1 : 0;
    // 回滚：switch 已被用户拖动，需重新克隆各插口以触发 checked 重新求值
    const rollback = () => {
      const plugs = this.data.plugs.slice();
      for (let i = 0; i < plugs.length; i++) plugs[i] = this.clonePlug(plugs, i);
      this.applyPlugs(plugs);
    };
    const doPublish = () => {
      this.syncBeforeChange().then(() => {
        const payload = { mac: device.normalizeMac(this.dev.mac) };
        const n = this.data.plugs.length;
        for (let i = 0; i < n; i++) payload['plug_' + i] = { on };
        if (!this.publishOrWarn(device.sendTopic(this.dev), JSON.stringify(payload))) {
          rollback();
          return;
        }
        const plugs = this.data.plugs.slice();
        for (let i = 0; i < plugs.length; i++) {
          plugs[i] = this.clonePlug(plugs, i);
          plugs[i].on = on === 1;
        }
        this.applyPlugs(plugs);
      });
    };
    // 关闭全部会切断所有插口供电，二次确认避免误触
    if (on === 0) {
      wx.showModal({
        title: '关闭全部插口',
        content: '确定要关闭所有插口吗？将切断全部供电（可能包括宿主机）。',
        confirmColor: '#fa5151',
        success: (res) => { if (res.confirm) doPublish(); else rollback(); },
        fail: rollback,
      });
    } else {
      doPublish();
    }
  },

  onPlugName(e) {
    const id = Number(e.currentTarget.dataset.id);
    // 越界保护：dataset 缺失时 Number(undefined)=NaN，后面 publish 会构造
    // plug_NaN 这种固件无法识别的字段，表现为「改了名但设备没变」。
    if (!Number.isInteger(id) || id < 0 || id >= this.data.plugs.length) return;
    const cur = this.data.plugs[id];
    if (!cur) return;
    wx.showModal({
      title: '修改名称',
      editable: true,
      placeholderText: '请输入名称',
      content: cur.name,
      success: (res) => {
        const name = (res.content || '').trim();
        if (!res.confirm || !name) return;
        this.syncBeforeChange().then(() => {
          // 等待同步期间用户可能已退出本页（onUnload 后 this.dev 仍在，
          // 但继续下发会写到一个已经没人看的页面上），这里做一次存活校验。
          if (!this.dev || this.data.mac !== device.normalizeMac(this.dev.mac)) return;
          const payload = { mac: device.normalizeMac(this.dev.mac), ['plug_' + id]: { setting: { name } } };
          if (!this.publishOrWarn(device.sendTopic(this.dev), JSON.stringify(payload))) return;
          // 下发成功后才乐观更新：不等设备回包，立即反映到界面
          const plugs = this.data.plugs.slice();
          if (!plugs[id]) return;
          plugs[id] = this.clonePlug(plugs, id);
          plugs[id].name = name;
          this.setData({ plugs });
        });
      },
    });
  },

  /* ---------- 定时任务 ---------- */
  // 下发某插口某一条任务配置到设备。返回是否成功发出（未连接时返回 false）。
  sendTask(plugId, taskIdx, task) {
    const payload = {
      mac: device.normalizeMac(this.dev.mac),
      ['plug_' + plugId]: {
        setting: {
          ['task_' + taskIdx]: {
            hour: task.hour, minute: task.minute, repeat: task.repeat,
            action: task.action, on: task.on ? 1 : 0,
          },
        },
      },
    };
    return this.publishOrWarn(device.sendTopic(this.dev), JSON.stringify(payload));
  },

  // 打开某插口的定时任务弹窗
  openTask(e) {
    const plugId = Number(e.currentTarget.dataset.id);
    if (!Number.isInteger(plugId) || plugId < 0 || plugId >= this.data.plugs.length) return;
    const plug = this.data.plugs[plugId];
    if (!plug) return;
    const taskSlots = [];
    for (let j = 0; j < TASK_SLOTS; j++) taskSlots.push(taskView((plug.tasks || [])[j]));
    this.setData({ showTask: true, taskPlugId: plugId, taskPlugName: plug.name, taskSlots, selIdx: -1 });
    // 打开即拉一次最新状态：弹窗里的定时任务是设备端数据，本地 plugs 可能已过期
    // 打开即拉一次最新状态：弹窗里的定时任务是设备端数据，本地 plugs 可能已过期。
    // ⚠️ 只读这一个插口(plugId)，绝不批量读全插口的 task——超大报文会害固件重启（电源重启）。
    if (mqtt.getStatus() === 'connected') device.requestState(this.dev, { plugId });
  },
  closeTask() {
    // taskPlugId 一并复位：不清的话，「等待同步期间用户关掉弹窗」这类竞态里
    // 残留的 plugId 会让后续逻辑误判成弹窗仍开着（见 onTaskSlotEnable / saveTask 的守卫）。
    this.setData({ showTask: false, selIdx: -1, taskPlugId: -1, taskSlots: [] });
  },

  // 选中某条任务进入编辑
  selectTask(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const slot = this.data.taskSlots[idx];
    if (!slot) return;
    const week = [];
    for (let i = 0; i < 7; i++) week.push({ n: WEEK_SHORT[i], on: (slot.repeat & (1 << i)) !== 0 ? 1 : 0 });
    this.setData({
      selIdx: idx,
      editHour: slot.hour,
      editMinute: slot.minute,
      editAction: slot.action,
      editOn: slot.on ? 1 : 0,
      editHourText: pad(slot.hour),
      editMinuteText: pad(slot.minute),
      week,
    });
  },

  onTaskHour(e) {
    const v = Number(e.detail.value);
    if (!Number.isInteger(v) || v < 0 || v > 23) return;
    this.setData({ editHour: v, editHourText: this.data.hourRange[v] });
  },
  onTaskMinute(e) {
    const v = Number(e.detail.value);
    if (!Number.isInteger(v) || v < 0 || v > 59) return;
    this.setData({ editMinute: v, editMinuteText: this.data.minuteRange[v] });
  },
  onTaskAction(e) { this.setData({ editAction: Number(e.currentTarget.dataset.v) === 0 ? 0 : 1 }); },
  onTaskEnable(e) { this.setData({ editOn: e.detail.value ? 1 : 0 }); },
  onTaskWeek(e) {
    const i = Number(e.currentTarget.dataset.i);
    const week = this.data.week.slice();
    if (!Number.isInteger(i) || i < 0 || i > 6 || !week[i]) return;
    week[i] = Object.assign({}, week[i], { on: week[i].on ? 0 : 1 });
    this.setData({ week });
  },

  // 在任务列表里直接开关某条任务的启用状态
  onTaskSlotEnable(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const on = e.detail.value ? 1 : 0;
    const plugId = this.data.taskPlugId;
    const plug = this.data.plugs[plugId];
    if (!plug || !plug.tasks || !plug.tasks[idx]) return;
    // 弹窗内的开关同样受控：取消/失败时需显式回滚 checked。
    // 必须重建对象引用（taskView 产出新对象），否则 Skyline 下 checked 不会重新求值。
    const rollback = () => {
      const cur = this.data.plugs[plugId];
      const taskSlots = this.data.taskSlots.slice();
      taskSlots[idx] = taskView(cur && cur.tasks ? cur.tasks[idx] : undefined);
      this.setData({ taskSlots });
    };
    this.syncBeforeChange().then(() => {
      // 用户在等待期间可能已关闭弹窗（closeTask 会把 selIdx 置 -1 但不清 taskPlugId），
      // 此时再下发会写错插口，直接放弃并回滚。
      if (!this.data.showTask || this.data.taskPlugId !== plugId) { rollback(); return; }
      // 同步可能刷新了 plugs，这里重新取一次任务作为基线
      const fresh = this.data.plugs[plugId];
      if (!fresh || !fresh.tasks || !fresh.tasks[idx]) { rollback(); return; }
      const t = Object.assign({}, fresh.tasks[idx], { on });
      // 先下发，成功后才更新界面
      if (!this.sendTask(plugId, idx, t)) { rollback(); return; }
      const plugs = this.data.plugs.slice();
      plugs[plugId] = this.clonePlug(plugs, plugId);
      plugs[plugId].tasks[idx] = t;
      const taskSlots = this.data.taskSlots.slice();
      taskSlots[idx] = taskView(t);
      this.setData({ plugs, taskSlots });
    });
  },

  // 保存编辑中的任务
  saveTask() {
    const idx = this.data.selIdx;
    if (idx < 0) return;
    const plugId = this.data.taskPlugId;
    // 编辑值在弹窗内已确定，不随后续同步变化；同步只是为了拿到最新的其它插口/任务作为基线
    const t = {
      hour: this.data.editHour,
      minute: this.data.editMinute,
      repeat: buildRepeat(this.data.week),
      action: this.data.editAction,
      on: this.data.editOn,
    };
    // 下发前必须校验：这些值会直接进 JSON 发给固件，出现 NaN/undefined 会被固件
    // 解析成 0 或忽略，导致定时任务写到错误的时间甚至静默失效。
    if (!Number.isInteger(t.hour) || t.hour < 0 || t.hour > 23 ||
        !Number.isInteger(t.minute) || t.minute < 0 || t.minute > 59 ||
        !Number.isInteger(t.repeat) || t.repeat < 0 || t.repeat > 0x7f ||
        !Number.isInteger(t.action) || !Number.isInteger(t.on)) {
      wx.showToast({ title: '任务参数无效，请重新设置', icon: 'none' });
      return;
    }
    this.syncBeforeChange().then(() => {
      if (!this.data.showTask || this.data.taskPlugId !== plugId || this.data.selIdx !== idx) return;
      if (!this.sendTask(plugId, idx, t)) return;
      const plugs = this.data.plugs.slice();
      plugs[plugId] = this.clonePlug(plugs, plugId);
      plugs[plugId].tasks[idx] = t;
      const taskSlots = this.data.taskSlots.slice();
      taskSlots[idx] = taskView(t);
      this.setData({ plugs, taskSlots, selIdx: -1 });
      wx.showToast({ title: '已保存', icon: 'success' });
    });
  },

  // 删除当前选中的任务（下发「空任务」语义：action=0 + on=0 + 不重复）
  delTask() {
    const idx = this.data.selIdx;
    if (idx < 0) return;
    const plugId = this.data.taskPlugId;
    // 删除是破坏性操作，先同步一次，避免基于过期快照误删
    this.syncBeforeChange().then(() => {
      // 等待期间弹窗被关闭或切到了别的任务：放弃，避免删错槽位
      if (!this.data.showTask || this.data.taskPlugId !== plugId || this.data.selIdx !== idx) return;
      const t = clearedTask();
      if (!this.sendTask(plugId, idx, t)) return;
      const plugs = this.data.plugs.slice();
      plugs[plugId] = this.clonePlug(plugs, plugId);
      plugs[plugId].tasks[idx] = t;
      const taskSlots = this.data.taskSlots.slice();
      taskSlots[idx] = taskView(t);
      this.setData({ plugs, taskSlots, selIdx: -1 });
      wx.showToast({ title: '已删除', icon: 'success' });
    });
  },
});
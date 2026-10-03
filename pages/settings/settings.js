// pages/settings/settings.js
const config = require('../../utils/config.js');
const mqtt = require('../../utils/mqtt.js');
const { statusText } = require('../../utils/status.js');

Page({
  data: {
    url: '',
    path: '/',
    username: '',
    password: '',
    hasPassword: false, // 本地已存密码；密码框不回填，留空即沿用
    keepalive: '60',
    status: 'unconnected',
    statusText: '未连接',
    fatalReason: '', // 账密错误等「重连也没用」的原因，常驻展示便于排查
    showPass: false, // 密码可见性切换：默认掩码，用户主动点开才明文
  },

  onLoad() {
    const c = config.load();
    this.setData({
      url: c.url || '',
      path: c.path || config.DEFAULT_CONFIG.path,
      username: c.username || '',
      // 安全：不回填明文密码到输入框，仅记录「是否已存在」用于占位提示。
      password: '',
      hasPassword: !!c.password,
      keepalive: String(c.keepalive || 60),
    });
  },
  onShow() {
    if (!this.unwatch) {
      this.unwatch = getApp().globalData.watchStatus((s) => this.setStatus(s, true));
    }
    this.setStatus(mqtt.getStatus(), true);
    this.setData({ fatalReason: getApp().globalData.fatalReason || '' });
  },
  onHide() { if (this.unwatch) { this.unwatch(); this.unwatch = null; } },
  onUnload() { if (this.unwatch) { this.unwatch(); this.unwatch = null; } },

  // force：跳过「状态未变则不写」。onShow 是初始化路径，必须写一次，
  // 因为 globalData.setStatus 现已对同状态去重，watchStatus 的立即回调可能被跳过。
  setStatus(s, force) {
    if (!force && s === this.data.status) return;
    this.setData({ status: s, statusText: statusText(s) });
  },

  onUrl(e) { this.setData({ url: e.detail.value }); },
  onPath(e) { this.setData({ path: e.detail.value }); },
  onUser(e) { this.setData({ username: e.detail.value }); },
  onPass(e) { this.setData({ password: e.detail.value }); },
  onKeep(e) { this.setData({ keepalive: e.detail.value }); },
  togglePass() { this.setData({ showPass: !this.data.showPass }); },

  buildConfig() {
    // 密码留空 = 沿用已保存的密码。仅在「用户名非空」时沿用——这样用户把用户名
    // 一起清空即可切换到匿名连接，不会出现「改了用户名却仍带着旧密码」的错配。
    const saved = config.load();
    const typed = this.data.password;
    const username = this.data.username.trim();
    let password = '';
    if (typed !== '') password = typed;
    else if (username !== '') password = saved.password || '';
    return {
      url: this.data.url.trim(),
      path: this.data.path.trim(),
      username,
      password,
      keepalive: parseInt(this.data.keepalive, 10) || 60,
    };
  },

  onSaveAndConnect() {
    const cfg = this.buildConfig();
    if (!cfg.url) { wx.showToast({ title: '请填写服务器地址', icon: 'none' }); return; }
    // 关匿名后账密必填。不校验的话用户会一直卡在「用户名或密码错误」，
    // 却以为是服务器或网络问题（BYOS 场景下这类误判排查成本极高）。
    if (!cfg.username || !cfg.password) {
      wx.showModal({
        title: '缺少登录凭据',
        content: '服务端已关闭匿名连接，必须填写用户名和密码才能连上。请先在你的 MQTT 服务里创建账号。',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }
    getApp().connectMqtt(cfg);
    // 已保存的密码不回显在输入框，避免明文长期停留在页面上
    this.setData({ password: '', hasPassword: !!cfg.password, fatalReason: '' });
    wx.showToast({ title: '正在连接…', icon: 'none' });
  },

  onDisconnect() {
    getApp().disconnectMqtt();
    wx.showToast({ title: '已断开', icon: 'none' });
  },

  onClearDevices() {
    wx.showModal({
      title: '清空设备',
      content: '确定清空所有本地设备列表吗？',
      confirmColor: '#fa5151',
      success: (res) => {
        if (!res.confirm) return;
        const device = require('../../utils/device.js');
        const n = device.clearAll(); // 内部只广播一次，避免 N 次 setData
        wx.showToast({ title: n ? `已清空 ${n} 台` : '列表本来就是空的', icon: 'none' });
      },
    });
  },
});
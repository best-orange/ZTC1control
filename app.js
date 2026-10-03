// app.js
const mqtt = require('./utils/mqtt.js');
const config = require('./utils/config.js');
const device = require('./utils/device.js'); // 启动即登记 device/# 订阅 + 连接后全量刷新

App({
  globalData: {
    status: 'unconnected', // unconnected/connecting/connected/reconnecting
    // 最近一次「不可自动恢复」的拒绝原因（账密错误等）。存在时不再自动重连，
    // 需用户去设置页改配置后重新发起连接。
    fatalReason: '',
    statusWatchers: [],
    watchStatus(cb) {
      this.statusWatchers.push(cb);
      cb(this.status);
      return () => {
        const i = this.statusWatchers.indexOf(cb);
        if (i >= 0) this.statusWatchers.splice(i, 1);
      };
    },
    setStatus(s) {
      // 去重：同一状态的重复广播不再通知订阅者。
      // watchStatus 注册时会立即回调一次，配合 mqtt 的 connecting/connected 多路径上报，
      // 不去重会让每个页面在短时间内收到多次相同的 setData。
      if (s === this.status) return;
      this.status = s;
      this.statusWatchers.forEach((f) => { try { f(s); } catch (e) {} });
    },
  },

  onLaunch() {
    // 统一 MQTT 事件
    mqtt.setMqttHandler((e) => {
      if (e.type === 'connected') {
        // 与安卓 MqttConnected 对齐：连接成功后向所有设备全量查询一次状态
        this.globalData.fatalReason = '';
        mqtt.clearFatalReason();
        this.globalData.setStatus('connected');
        device.requestAllStates();
      }
      else if (e.type === 'suback') { this.globalData.setStatus('connected'); }
      else if (e.type === 'connecting') { this.globalData.setStatus('connecting'); }
      else if (e.type === 'connack-error') {
        // 服务器拒绝连接（如账密错误），重连无意义，停止并提示原因
        this.globalData.fatalReason = e.reason || '连接被拒绝';
        this.globalData.setStatus('unconnected');
        wx.showToast({ title: '服务器拒绝：' + e.reason, icon: 'none', duration: 3000 });
      }
      else if (e.type === 'message') { /* 设备消息由 device.js 内部路由 */ }
    });
    // 启动时自动连接保存的配置（跳过占位域名）
    const cfg = config.load();
    const isPlaceholder = !cfg.url || config.isPlaceholderUrl(cfg.url);
    if (!isPlaceholder) this.connectMqtt(cfg);
  },

  connectMqtt(cfg) {
    config.save(cfg);
    // 用户主动发起 = 明确要重试，清掉上次的致命错误标记
    this.globalData.fatalReason = '';
    mqtt.clearFatalReason();
    mqtt.disconnect();
    // 第二个参数 true = 用户主动发起，重置自动重连的退避计数
    mqtt.connect(cfg, true);
    this.globalData.setStatus('connecting');
  },

  disconnectMqtt() {
    mqtt.disconnect();
    this.globalData.setStatus('unconnected');
  },
});
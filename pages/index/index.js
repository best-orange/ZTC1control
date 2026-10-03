// pages/index/index.js
const device = require('../../utils/device.js');
const mqtt = require('../../utils/mqtt.js');
const { statusText } = require('../../utils/status.js');

Page({
  data: {
    list: [],
    status: 'unconnected',
    statusText: '未连接',
  },

  onLoad() {
    this.refreshList();
  },

  onShow() {
    const app = getApp();
    if (!this.unwatchStatus) {
      this.unwatchStatus = app.globalData.watchStatus((s) => this.setStatus(s, true));
    }
    if (!this.unwatchList) this.unwatchList = device.onChanged(() => this.refreshList());
    this.refreshList();
    this.updateStatusText();
  },

  onHide() {
    if (this.unwatchStatus) { this.unwatchStatus(); this.unwatchStatus = null; }
    if (this.unwatchList) { this.unwatchList(); this.unwatchList = null; }
  },
  onUnload() {
    if (this.unwatchStatus) { this.unwatchStatus(); this.unwatchStatus = null; }
    if (this.unwatchList) { this.unwatchList(); this.unwatchList = null; }
  },

  // force=true 时跳过「与 data.status 相同则不写」的去重。
  // 必要性：globalData.setStatus 现在对同状态不广播，页面从后台回来时
  // data.status 可能因上一次 onHide 前的最后一次广播而恰好相等，但
  // statusText 等派生字段未必同步过；初始化路径（onShow）必须强制写一次。
  setStatus(s, force) {
    if (!force && s === this.data.status) return;
    this.setData({ status: s, statusText: statusText(s) });
  },

  updateStatusText() {
    this.setStatus(mqtt.getStatus(), true);
  },

  refreshList() {
    const list = device.getList().map((d) => ({
      ...d,
      typeName: (device.typeAt(d.type) || {}).name || '',
      online: device.isOnline(d.mac),
    }));
    // 无变化时跳过 setData：onChanged 广播 + onShow 手动刷新会连续触发两次，
    // 每次都提交整个 list 数组在 Skyline 下是不必要的跨线程开销。
    if (JSON.stringify(list) === JSON.stringify(this.data.list)) return;
    this.setData({ list });
  },

  onPullDownRefresh() {
    this.refreshList();
    this.updateStatusText();
    // 下拉刷新做一次真正的「重新拉状态」：否则用户下拉后看到的是缓存，
    // 与顶部「刷新」按钮行为不一致，容易被误判成刷新没生效。
    if (device.getList().length && mqtt.getStatus() === 'connected') device.requestAllStates();
    wx.stopPullDownRefresh();
    wx.showToast({ title: '已刷新', icon: 'none', duration: 1200 });
  },

  // 手动刷新：重发全量状态查询到所有设备，并同步列表与连接状态。
  // 说明：列表本身走本地 Storage，刷新不会改变设备清单；这里刷新的是
  // 「在线状态 + 各设备最新上报」，所以需要主动下发查询而不是仅重绘。
  onRefresh() {
    this.refreshList();
    this.updateStatusText();
    if (!device.getList().length) {
      wx.showToast({ title: '还没有设备', icon: 'none', duration: 1500 });
      return;
    }
    if (!device.requestAllStates()) {
      wx.showToast({ title: '未连接服务器，状态未刷新', icon: 'none', duration: 2000 });
      return;
    }
    wx.showToast({ title: '已请求刷新', icon: 'none', duration: 1200 });
  },

  // 点设备名改名（仅改本地显示名，不下发设备）
  onRename(e) {
    const mac = e.currentTarget.dataset.mac;
    const cur = e.currentTarget.dataset.name || '';
    if (!mac) return;
    // 改名时点击行内文本不应触发整行的跳转，这里已由 wxml 的 catchtap 拦截冒泡
    wx.showModal({
      title: '修改设备名称',
      editable: true,
      placeholderText: '请输入名称',
      content: cur,
      success: (res) => {
        if (!res.confirm) return;
        const name = (res.content || '').trim();
        // device.rename 内部会 fire() → 已注册的 onChanged 会自动 refreshList，
        // 此处不再手动刷新，避免一次改名触发两次 setData。
        const r = device.rename(mac, name);
        if (!r.ok) wx.showToast({ title: r.msg || '修改失败', icon: 'none' });
      },
    });
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/device-add/device-add' });
  },
  goSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' });
  },
  openDevice(e) {
    // 长按删除后的 follow-up tap 需忽略，避免误跳转
    if (this.longPressFired) {
      this.longPressFired = false;
      return;
    }
    const mac = e.currentTarget.dataset.mac;
    wx.navigateTo({ url: '/pages/device-control/device-control?mac=' + mac });
  },
  onDeviceLongPress(e) {
    const mac = e.currentTarget.dataset.mac;
    this.longPressFired = true;
    wx.showModal({
      title: '删除设备',
      content: '确定要删除该设备吗？',
      confirmColor: '#fa5151',
      success: (res) => {
        if (res.confirm) {
          device.remove(mac);
          this.refreshList();
        }
      },
    });
  },
});
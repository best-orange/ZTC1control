// pages/device-add/device-add.js
const device = require('../../utils/device.js');

Page({
  data: {
    types: [],
    typeIndex: 1, // 默认 zTC1
    typeRange: [],
    type: '',
    typeZone: '',
    mac: '',
    adding: false,
  },

  onLoad() {
    const types = device.getTypes();
    // 默认展示全部类型（含未配对页面的）
    this.setData({
      types,
      typeRange: types.map((t, i) => `${i} - ${t.name}`),
      typeIndex: 1,
    });
    this.updateType();
  },

  onTypeChange(e) {
    const i = Number(e.detail.value);
    // 越界保护：dataset/picker 取值异常时 Number(...) 可能是 NaN，
    // 后续 this.data.types[NaN] 为 undefined，updateType 会把类型名渲染成空。
    if (!Number.isInteger(i) || i < 0 || i >= this.data.types.length) return;
    this.setData({ typeIndex: i });
    this.updateType();
  },

  updateType() {
    const t = this.data.types[this.data.typeIndex];
    this.setData({ type: t ? t.name : '', typeZone: t ? t.zone : '' });
  },

  onMac(e) { this.setData({ mac: e.detail.value }); },

  onAdd() {
    if (this.data.adding) return;
    const type = this.data.types[this.data.typeIndex];
    if (!type) { wx.showToast({ title: '请选择设备类型', icon: 'none' }); return; }
    const raw = (this.data.mac || '').trim();
    if (!raw) { wx.showToast({ title: '请填写 MAC 地址', icon: 'none' }); return; }

    // 归一化后必须是 12 位十六进制。设备端 topic 里的 MAC 就是 12 位 hex，
    // 只做「长度 >= 6」的宽松校验会放进 8 位/含非法字符的脏值，
    // 表现为「设备加得进去、但永远离线且点了没反应」，排查成本很高。
    const mac = device.normalizeMac(raw);
    if (!/^[0-9a-f]{12}$/.test(mac)) {
      wx.showModal({
        title: 'MAC 格式不正确',
        content: `归一化后为「${mac || '(空)'}」，需要 12 位十六进制字符（0-9 / a-f）。请核对设备标签上的 MAC。`,
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }

    // 不传名字：device.add 会用设备类型名兜底，用户添加后在列表页点名字即可改名
    const res = device.add(type.id, '', mac);
    if (!res.ok) {
      wx.showToast({ title: res.msg || '添加失败', icon: 'none' });
      return;
    }
    this.setData({ adding: true });
    wx.showToast({ title: '已添加', icon: 'success' });
    setTimeout(() => {
      wx.navigateBack({ delta: 1 });
    }, 600);
  },
});

/**
 * status.js - MQTT 连接状态文案映射（统一三处页面的 statusText 逻辑）
 */

const TEXT = {
  connected: '已连接',
  connecting: '连接中…',
  reconnecting: '重连中…',
  unconnected: '未连接',
};

function statusText(s) {
  return TEXT[s] || '未连接';
}

module.exports = { statusText };
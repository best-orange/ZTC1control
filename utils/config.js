/**
 * config.js - 全局配置
 * MQTT 通过 Cloudflare Tunnel 暴露的 wss 端点（433/443）。
 * 默认地址为占位，用户在「设置」页可修改并持久化。
 */

const STORAGE_KEY = 'mqtt_config';

// 默认配置：你的 Cloudflare Tunnel 域名（已预橘）
const DEFAULT_CONFIG = {
  url: 'wss://mqtt.example.com', // CF Tunnel 域名(无端口=443)，替换为你自己的真实域名
  path: '/',                     // websocket 端点为根路径（与 curl 一致）
  username: '',
  password: '',
  clientId: '',
  keepalive: 60,
};

// 是否为占位/示例域名。精确匹配，避免被真实域名误判。
function isPlaceholderUrl(url) {
  if (!url) return true;
  // 提取 host（含二级域名后缀判断），仅识别 example.com / example.cn 等保留域与 your-domain
  return /(^|\/\/)([^/:@]+\.)?example\.(com|cn|org|net)([:/]|$)/i.test(url) ||
         /your-domain/i.test(url);
}

function load() {
  try {
    const saved = wx.getStorageSync(STORAGE_KEY);
    if (saved && typeof saved === 'object') {
      return Object.assign({}, DEFAULT_CONFIG, saved);
    }
  } catch (e) {}
  return Object.assign({}, DEFAULT_CONFIG);
}

function save(cfg) {
  try {
    wx.setStorageSync(STORAGE_KEY, Object.assign({}, cfg));
  } catch (e) {}
}

module.exports = {
  STORAGE_KEY,
  DEFAULT_CONFIG,
  load,
  save,
  isPlaceholderUrl,
};
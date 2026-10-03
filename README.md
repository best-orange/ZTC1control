# SmartControl - 微信小程序重构版

将 Android 开源项目 [SmartControl_Android_MQTT](https://github.com/a2633063/SmartControl_Android_MQTT)
重构为微信小程序版本，用于远程控制作者的智能家居设备（zTC1/zDC1/MOPS/ButtonMate 等 ESP8266 固件）。

## 产品形态：BYOS（Bring Your Own Server）

**用户自己搭建 MQTT 服务**，在小程序「设置」页填入服务器地址 + 用户名 + 密码。
本项目**不提供后端服务**，没有账号体系，不收集任何用户数据。

```
用户自建 Mosquitto ──TCP 1883──▶ 设备(ESP8266)
        ▲
        │ WS/WSS
用户自建 cloudflared ──▶ Mosquitto WS(9003)
        ▲
        │ wss://<用户自己的域名>:443
      小程序
```

> 因是 BYOS，**每个用户连的都是自己的 broker**，不存在多租户隔离问题。
> 安全边界由用户自己的 broker 配置决定（关匿名 + 强密码 + wss）。

## 关键架构决策

小程序只能使用 WebSocket(`wx.connectSocket`)，**不能**：
- ❌ 直连 MQTT TCP(1883)
- ❌ 使用 UDP（局域网广播/发现）—— 原 Android 的 UDP 通道在小程序内无法复用

因此小程序端通过 **broker 的 WebSocket(WSS) 通道**连接，由 broker 在 WSS 与设备 TCP(1883) 之间转发。

## 服务端配置要点

**必须关闭匿名连接**，否则任何知道域名的陌生人即可连接：

```conf
allow_anonymous false
password_file /mosquitto/config/passwd
per_listener_settings false

listener 1883
protocol mqtt

listener 9003
protocol websockets
bind_address 127.0.0.1      # 只绑本地，由 CF Tunnel 转发进来
```

```bash
# 创建账号（交互式输密码，不要用 -p，会进 shell 历史与 ps 输出）
mosquitto_passwd -c /mosquitto/config/passwd youruser
# ⚠️ 加第二个用户时必须去掉 -c，否则会清空重建整个密码文件
mosquitto_passwd /mosquitto/config/passwd youruser2
```

**NAS / CF Tunnel 侧要点**：
1. 用 `cloudflared` 建一条到 `mqtt.你的域名.com` 的 Tunnel，把 `wss://域名:443` 转发到 `127.0.0.1:9003`。
2. 小程序后台「开发 → 服务器域名 → WebSocket 合法域名」加入 `wss://mqtt.你的域名.com`。
   > ⚠️ 合法域名必须由**小程序主体**在后台报备。用户自建的域名若不在白名单内，
   > **正式版会被拦截**（开发版可勾选「不校验合法域名」绕过）。这是 BYOS 模式的结构性限制。
3. 开发阶段在微信开发者工具勾选「不校验合法域名」。
4. `wss://` 是硬要求 —— MQTT over WebSocket 在 TLS 之前不做内容加密，
   `ws://` 等价于明文广播密码。

详细方案与上线清单见 **[docs/安全方案与上线清单.md](docs/安全方案与上线清单.md)**。

## 目录结构

```
app.js                    全局入口，负责 MQTT 连接与状态
app.json                  页面注册
utils/
  mqtt.js                 零依赖 MQTT 3.1.1 over WebSocket 客户端（带断线重连、连接代次号防竞态）
  config.js               服务器配置读写(Storage)
  device.js               设备模型/存储/topic 路由/在线状态
  status.js               连接状态文案映射
pages/
  index/index             设备列表
  device-add/device-add   添加设备（选类型 + 填 MAC）
  device-control/device-control  设备控制页（已实现标准插口型设备）
  settings/settings       MQTT 服务器配置（地址/账密/心跳）+ 连接控制
docs/
  安全方案与上线清单.md     BYOS 安全态势、自建服务配置、合规项
```

## 设备控制协议（沿用原版）

- 发送(控制)：`device/{zone}/{mac}/set`
- 订阅(读取)：`device/{zone}/{mac}/state`、`/sensor`、`/availability`
- JSON 示例（zTC1 6 口排插）：
  ```json
  {"mac":"d0bce4638baa","plug_0":{"on":1}}
  {"mac":"...","plug":{"setting":{"name":"客厅灯"}}}
  ```
  sensor: `{"mac":"...","power":"24.7","total_time":9139790}`

小程序通过 `device/#` 通配订阅，`device.js:routeMessage` 解析并转发给对应设备页。

> ⚠️ **读写共用 topic 的坑**：`/set` 同时用于查询与写入，固件靠字段值区分意图。
> 所有读取意图必须用 `null` 显式表达，**绝不能发 `task_N:{}` 空对象**
> （会被固件当作写入并清空用户定时任务）。详见 `device.js:requestState` 注释。

## 已实现 / 待实现

- [x] 自写 MQTT-WebSocket 客户端（连接/订阅/发布/心跳/断线重连/代次号防竞态）
- [x] 设备列表(在线状态、长按删除、点击改名)
- [x] 添加设备（MAC 格式校验 + 自动归一化）
- [x] 设置页(服务器/账密/心跳 + 密码显隐 + 致命错误常驻提示)
- [x] zTC1(6) 、DC1/MOPS 等「插口开关」型设备控制
- [x] 定时任务（每插口 5 组，含改前同步防覆盖）
- [ ] 非插口设备的专控界面（净化器/检测仪/体重秤/时钟/灯）
- [ ] OTA 提示、设备分组排序
- [ ] 自建服务的一键部署脚本 + 图文教程

## 限制（小程序固有）

- 无 UDP：局域网广播式发现不可用，需手动录入 MAC（或靠 MQTT availability 上报在线）。
- 无 TCP：只能 WSS，必须配 broker WebSocket + 合法域名。
- 正式发布强制 `wss` + 合法域名；调试可用开发者工具关闭校验。
- **合法域名只能由小程序主体报备**：用户自建域名不在白名单时正式版无法连接。
# 模拟上位机（tools/mock-upper）

## 用途

在真实的**设备 PC 上位机接口（需求 Q-21）**到位之前，用本工具模拟上位机对外提供实时测量数据，用于：

1. **看板取数自测** —— 看板按接口规范取数、解析、显示，联调前就能跑通；
2. **作为参考实现发给上位机方** —— 把本工具产出的字段与样例报文附给对方，请其确认或修订，从"等对方给规范"变成"我们给一版请对方确认"。

> 字段契约以 `src/config/fieldMap.js` 的 `upperToBoard` 为准。**改动字段时须同时修改该文件与本工具**。

## 运行

```bat
REM 方式一：双击 start.cmd（会先切 UTF-8 控制台，避免中文日志乱码）
REM 方式二：命令行
node mock-upper.js --help
node mock-upper.js --port 8801
```

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--port <n>` | 8801 | HTTP 服务端口 |
| `--interval <ms>` | 1000 | 推送周期（毫秒） |
| `--push <url>` | — | 周期性 POST 报文到该地址；留空则只提供查询服务 |
| `--equip <code>` | SX-UNDERWATER-001 | 设备编号 |
| `--cycle <sec>` | 160 | 单件测试节拍（秒） |
| `--plan <n>` | 180 | 当班计划数量 |
| `--once` | — | 只发一帧后退出（连通性自测）；不带 `--push` 时直接打印一帧样例报文 |

### 提供的接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/realtime` | 返回一帧实时报文（JSON） |
| GET | `/sample` | 同 `/realtime` |
| GET | `/health` | 健康检查 |

## 常用示例

```bat
REM 1) 打印一帧样例报文（发给上位机方参考用）
node mock-upper.js --once

REM 2) 起服务，供看板或联调方按 1s 轮询
node mock-upper.js --port 8801

REM 3) 主动推送到看板服务的 IF-D 接收端点（地址联调时替换）
node mock-upper.js --push http://127.0.0.1:9000/api/upper/realtime --interval 1000

REM 4) 快速连通性自测：推一帧到模拟 MES（验证 HTTP 链路是否通）
node mock-upper.js --once --push http://127.0.0.1:8802/service/upper/realtime
```

## 报文字段（与 `fieldMap.upperToBoard` 键一致）

| 分类 | 字段 | 说明 |
| --- | --- | --- |
| 标识 | `equipCode`、`procOrderNo`、`collectTime` | 设备编号、生产任务编号、采集时间 |
| 状态 | `testStatus`、`stage`、`linkStatus` | 状态码 0~3、运行阶段（准备/运行/判定/完成）、链路状态 |
| 实测 | `depth`、`speed`、`velocity_x`、`velocity_y` | **航行器**水下深度与速度（主要展示对象） |
| 设备参数 | `frameRate`、`gain`、`shutter`、`cameraDepth` | 帧率/增益/快门、**相机自身**水下深度 |
| 工单 | `productCode`、`productName`、`batchNo`、`drawingNo`、`orderNo`、`planQty` | 工单与计划量 |
| 测试标准 | `stdDepth`、`stdGain`、`stdFps`、`stdShutter` | 设定阈值，用于与实测值对照判定 |
| 进度结果 | `result`、`unitIndex`、`progress` | 单任务结果、件号、进度（0~1） |

> **注意区分**：`depth` 是**航行器**水下深度；`cameraDepth` 是**相机自身**水下深度（现场传感器）。两者不可混用。

## 与看板联调时的对接方式

| 场景 | 目标地址 |
| --- | --- |
| 看板主动轮询上位机 | 本工具 `GET /realtime` |
| 上位机主动推送看板 | 看板服务的 IF-D 接收端点（如 `http://<看板主机>:9000/api/upper/realtime`） |

看板侧对应配置项在 `src/config/board.config.js` 的 `upper` 段（`url`、`timeoutMs`、`staleMs`）。

## 排查

| 现象 | 处理 |
| --- | --- |
| 控制台中文乱码 | 用 `start.cmd` 启动，或先执行 `chcp 65001` |
| 推送失败 `ECONNREFUSED` | 目标服务未启动，或端口/路径不对 |
| 看板显示"数据已冻结" | 超过 `upper.staleMs`（默认 5 s）未收到新数据，检查推送周期与目标地址 |

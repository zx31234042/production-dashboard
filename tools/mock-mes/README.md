# 模拟 MES 端（tools/mock-mes）

## 用途

在真实的 **MES 接口（需求 Q-23）**到位之前，用本工具当"假 MES"，让看板的**上报、回执、失败补传**逻辑在联调前就能自测：

1. **作为接收方**：接收看板上报的报文（附录 2 的 13 个字段），按配置返回回执；
2. **作为发起方**：模拟 MES 向看板下发派工信息（接口 IF-A）；
3. **回执风格可切换**：在 `{status,msg,data}` 与 `{code,msg,uploadId}` 之间切换，用于验证 Q-23 中"回执结构以哪套为准"的两种可能；
4. **可注入异常**：按概率返回异常回执，用于验证失败缓存与指数退避补传（IF-B.9）。

## 运行

```bat
REM 方式一：双击 start.cmd（会先切 UTF-8 控制台，避免中文日志乱码）
REM 方式二：命令行
node mock-mes.js --help
node mock-mes.js --receipt status
```

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--port <n>` | 8802 | 本服务端口 |
| `--receipt <style>` | status | 回执风格：`status` = `{status,msg,data}`（接口定义）；`code` = `{code,msg,uploadId}`（附录 2） |
| `--fail-rate <0~1>` | 0 | 按概率返回异常回执，用于测试补传 |
| `--board <url>` | — | 看板服务地址，用于模拟 IF-A 派工下发 |
| `--dispatch-every <ms>` | 0 | 每隔多少毫秒下发一次派工（0 = 不下发） |

### 提供的接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/service/:serviceName/:methodName` | **接收看板上报**，返回回执（路径按接口定义模板） |
| POST | `/dispatch` | 手动触发一次派工下发（需 `--board`） |
| GET | `/log` | 查看已收到的报文（最近 50 条 + 统计） |
| DELETE | `/log` | 清空日志 |
| GET | `/health` | 健康检查 |

## 常用示例

```bat
REM 1) 回执风格 status（接口定义的那套）
node mock-mes.js --receipt status

REM 2) 回执风格 code（附录 2 的那套），并注入 30% 异常
node mock-mes.js --receipt code --fail-rate 0.3

REM 3) 同时模拟 MES 下发派工到看板服务，每 30 秒一次
node mock-mes.js --board http://127.0.0.1:9000/api/mes/dispatch --dispatch-every 30000

REM 4) 查看收到了什么
curl http://127.0.0.1:8802/log
```

## 看板侧对应配置

| 配置项 | 位置 | 说明 |
| --- | --- | --- |
| `mes.baseUrl` | `src/config/board.config.js` | 指向本工具地址，如 `http://127.0.0.1:8802` |
| `mes.pathTemplate` | 同上 | 默认 `/service/{serviceName}/{methodName}` |
| `mes.responseStyle` | 同上 | 必须与启动本工具时的 `--receipt` 一致，否则回执判定会失败 |
| `mes.queueCap` | 同上 | 补传队列容量上限；满则**拒绝入队并告警**，不静默丢弃报文。**不做自动重试**（IF-B.9 V1.31）：上报失败只入队＋告警＋本地持久化留存，重报由人工 `Api.retryPending()` 触发（`mes.retry` 键已按 ADR-0005「死配置不留」删除） |

> `mes.baseUrl` 为空时，看板**不会发起上报**（属正常行为，避免未联调时报错）。配置后才开始周期上报。

## 验证清单（联调前自测用）

| 序号 | 验证项 | 期望结果 |
| --- | --- | --- |
| 1 | 看板配置 `mes.baseUrl` 后启动 | `GET /log` 收到周期上报，字段含 13 项 |
| 2 | `--receipt code` 与 `--receipt status` 各跑一次 | 看板都能正确判定回执成功 |
| 3 | `--fail-rate 0.5` | 看板进入补传流程，`getStatus().pendingCount` 增长后回落 |
| 4 | 停掉本工具再重启 | 看板补传此前失败的报文，`/log` 中 uploadId 不重复丢失 |
| 5 | `POST /dispatch`（配 `--board`） | 看板收到派工信息（IF-A） |
| 6 | 附录 2 的 `cameraDepth` 与 `depth` | 两个字段分别上报，数值不同、不被混用 |

## 排查

| 现象 | 处理 |
| --- | --- |
| 控制台中文乱码 | 用 `start.cmd` 启动，或先执行 `chcp 65001` |
| 看板判定回执失败 | 检查 `--receipt` 与 `board.config.js` 的 `mes.responseStyle` 是否一致 |
| `/log` 一直为空 | 看板未配置 `mes.baseUrl`，或路径模板不匹配 |
| 派工下发返回"未配置 --board" | 启动时加 `--board http://<看板服务>/...` |

# 测试与验证（tests/）

> 本项目当前为**无依赖的纯静态前端**，尚未引入自动化测试框架。
> 本目录先存放**手工验证清单**；后期引入测试工具后，自动化测试脚本也放在这里。

---

## 一、每次改动后必须做的验证（手工）

> 下面 1～5 项里可自动完成的部分已脚本化：第 1 项（控制台报错）、第 3 项（分辨率无滚动条）、第 4 项（特殊状态与参数）由 `tests/browser-check.js` 覆盖；第 2 项（逐页切换）也由它覆盖。方法与权限要求见第四节，剩余仍需人工判断的部分（配色观感、动效、截图比对）保留在本节。

### 1. 打开页面查报错

1. 双击根目录 `index.html`（或把 `index.html` 拖进浏览器）；
2. 按 `F12` 打开开发者工具，切到 **Console（控制台）** 标签；
3. 确认**没有红色报错**（黄色警告可忽略）；
4. 若出现红色报错，按报错里的文件名定位到 `src/` 下对应文件。

### 2. 逐个页面点一遍

依次点击底部 8 个标签，确认：

- 页面能正常切换，未出现空白页；
- 头部信息区（设备名、时钟、班次、人员）始终显示，不随切换消失；
- 底部状态区显示：版本、最后刷新时刻、上位机链路、MES 链路。

| 序号 | 页面 | 重点确认 |
| --- | --- | --- |
| 1 | 设备状态 | 运行模式与色带一致；航行器深度、航行速度有数值；两条任务曲线有图形或显示空态 |
| 2 | 任务数据 | 工单 8 项有值；深度/速度大号显示；进度条随秒推进；设备参数表有"正常/临近/超标"判定 |
| 3 | 班次信息 | 当前班次高亮；已进行/剩余时长随时间变化 |
| 4 | 生产统计 | 15 项统计有数值；合格率、稼动率在 0～100% 之间 |
| 5 | 设备异常 | 故障卡显示代码/类型/时间；预警 4 条；台账 5 行 |
| 6 | 维保台账 | 距下次维保天数与进度条一致；检修记录 4 行 |
| 7 | 公告备注 | 公告 5 条、工艺提示 5 条、待办 6 项 |
| 8 | 操作设置 | 默认锁定；输入 `8888` 后可录入与发布 |

### 3. 分辨率与缩放

在浏览器中把窗口调成以下尺寸，确认**没有横向滚动条、没有元素重叠**：

- 3840 × 2160（设计基准，75 寸电视 4K@30Hz）
- 1920 × 1080
- 1366 × 768

### 4. 特殊状态

| 操作 | 预期 |
| --- | --- |
| 键盘按 `D` | 运行模式转"故障锁定"、联网状态转红、底部弹出降级横幅；再按一次恢复 |
| 键盘按 `A` | 故障报警切换到下一条 |
| 地址栏加 `?curve=none` | 两条曲线显示空态提示"暂无已完成任务数据" |
| 地址栏加 `?link=off` | 以断连状态启动 |
| 地址栏加 `?unlock=1` | 以已解锁状态启动 |
| 地址栏加 `?tab=3` | 直接打开"生产统计"页 |

### 5. 数据与文案

- 中文无乱码；
- 数值格式统一：深度/速度 2 位小数、帧率整型、时间 `yyyy-MM-dd HH:mm:ss`；
- 修改需求后，界面文案与需求清单条款一致。

### 6. 数据源与接口链路（2026-09-18 新增）

| 序号 | 验证项 | 操作 | 期望结果 |
| --- | --- | --- | --- |
| 6.1 | 默认数据源 | 打开 `index.html` | 各页有数据，页脚右侧"上位机链路/MES 链路"显示正常 |
| 6.2 | 上位机报文数据源 | 地址栏加 `?source=upper` | 界面正常显示，深度/速度/帧率等由报文提供（走适配层，与真实链路一致） |
| 6.3 | 报文缺字段容错 | 临时把 `mockUpperSource.js` 某个字段删掉 | 该项**保持上一次数值不清零**，其余正常；控制台提示缺失字段 |
| 6.4 | 数据冻结判定 | 在 `board.config.js` 把 `upper.staleMs` 改小（如 500），再减速推送 | 超时后判定"数据已冻结" |
| 6.5 | 配置生效 | 改 `board.config.js` 的 `shift.list` 或 `production.planQty` | 界面班次/计划数随之变化，无需改代码 |
| 6.6 | 字段映射生效 | 改 `fieldMap.js` 某条映射的 `key` | 对应字段取值随之变化（证明字段名可配置） |
| 6.7 | 模拟上位机 | `node tools/mock-upper/mock-upper.js --once` | 打印一帧符合契约的报文，字段与 `fieldMap` 键一致 |
| 6.8 | 上报与回执（status 风格） | 起 `mock-mes --receipt status`，看板配置 `mes.baseUrl` | `GET /log` 收到周期上报，13 个字段齐全，回执判定成功 |
| 6.9 | 上报与回执（code 风格） | 起 `mock-mes --receipt code` | 回执判定同样成功（两种风格都兼容） |
| 6.10 | 失败补传 | 起 `mock-mes --fail-rate 0.5` | 失败报文进入待补传队列，恢复后补齐，`/log` 无丢号 |
| 6.11 | 派工下发（IF-A） | `mock-mes --board <看板地址>` 后 `POST /dispatch` | 看板收到派工信息 |

> 6.8～6.11 需要看板服务端提供接收端点；当前纯静态 Demo 下可先只验证 **6.1～6.7**。

---

## 二、改动后的收尾动作

- [ ] 重新截图：按 8 个页面 + 2 个特殊状态，覆盖 `src/assets/screenshots/` 下的同名文件；
- [ ] 重新生成交付文档：`输出文件\甲方\` 下的说明文档（命令见 `tools\Markdown转Word工具说明.md`）；
- [ ] 若改了需求：`需求文档\` 升版本号，旧版移入 `历史文件\`。

---

## 三、后期自动化测试（待建设）

引入测试工具后，建议按下面的顺序补充，脚本一律放在本目录：

| 优先级 | 测试对象 | 说明 |
| --- | --- | --- |
| 高 | `src/services/mockData.js` | 统计口径与公式：计划/开工/完成、合格率、稼动率、跨班次清零（FR-4） |
| 高 | `src/utils/format.js` | 时间与数值格式化边界（0 秒、跨小时、负数） |
| 中 | `src/components/CurveChart.js` | 空态、单点、量程自适应 |
| 中 | `src/pages/Dashboard.js` | 标签切换、无操作自动返回（FR-9.4） |
| 低 | 界面渲染 | 可引入截图对比，但需先确定基准图管理方式 |

> 约定：测试文件与源码文件**同名**（如 `mockData.test.js`），新增文件后在本表登记。

### 已落地的五个自检脚本（2026-09-18）

| 脚本 | 运行 | 覆盖 |
| --- | --- | --- |
| `tests/contract-check.js` | `node tests/contract-check.js`（零依赖，退出码 0 = 全通过，1 = 有失败） | A 附录 2 的 13 字段 ↔ `src/config/fieldMap.js`；B 上位机报文键 ↔ `fieldMap.samplePayload` ↔ `src/services/mockUpperSource.js` ↔ `tools/mock-upper`；C `src/services/api.js` 的缺字段/非数值容错、冻结判定、字段名与参数可配置；D 13 字段上报报文、两种回执风格、失败补传；E `?source=upper` 逐帧取数链路；F 数据冻结后界面判据 `state.device.link`、`Api.getStatus()` 是否被消费；G 当班统计非负、维保累计不倒退、待办与自检可闭环；H 公告/检修录入是否原样拼进 HTML；I 交付 `.docx` 的 ZIP 条目名（OPC）；J 源码/样式头部版本号与需求清单附录 2 项数一致性；K 现状快照（稼动率口径、台账行数）；L 常量集中化（JS 内联色值是否与 `variables.css` 重复、维保与耗材预警阈值是否跟随 `board.config`）。 |
| `tests/ui-check.js` | `node tests/ui-check.js`（零依赖；内存粗筛建议加 `--expose-gc`） | U1 布局与视觉规范：UI-01 三段式比例、UI-02 4K 舞台、UI-03 色彩变量、UI-04 字号（逐角色对照）；U2 需求条款：FR-1 十项头部字段、FR-2 五模式/时长/阶段/映射、FR-3 工单 8 项·数值格式·表格列数·超阈值判定·五态可达、FR-4 十五项指标与"开工 ≤ 计划"口径、FR-9 八个标签页；U3 空态（UI-11、FR-3.17）；U4 每秒整屏重绘的副作用（不得写表单 value、不得注册监听）；U5 性能微基准（单次 tick+全量重绘耗时、连续 2000 次后的堆增长）。判据用假 DOM 跑真实 `render()`，不启浏览器。 |
| `tests/tools-check.js` | `node tests/tools-check.js`（零依赖，会临时占用 18901～18906 端口） | T1 `mock-upper` 的 `/health`、`/realtime`、`/sample`、404 与报文自洽；T2 `--push` 与 `--once --push` 推送；T3 `mock-mes` 两种回执风格、`--fail-rate`、`/log`、`DELETE /log`；T4 派工下发 `POST /dispatch` 与 `--dispatch-every`；T5 端口冲突行为；T6 两个工具的命令行开关与各自 README 逐条一致。子进程以真实进程启动，观测全部走 HTTP 回环。 |
| `tests/browser-check.js` | `node tests/browser-check.js`（**需浏览器权限，见下节**） | B1 页面加载·无红色报错·首屏要素；B2 `?tab=`/`?curve=none`/`?link=off`/`?unlock=1`/`?source=upper`；B3 键盘 `D` 降级；B4 八个标签逐页切换且头部常显；B5 3840×2160 / 1920×1080 / 1366×768 无滚动条；B6 无操作 3 分钟自动回首页（虚拟时间快进）；B7 截图落到 `tests/._verify/`。 |
| `tests/docs-check.js` | `node tests/docs-check.js`（零依赖；会调用本机 PowerShell 5.1 跑 `tools/` 下两个转换脚本） | D1/D1b 文档转换工具的真实能力（四级标题·表格·列表·引用·代码块·行内格式·分隔线·图片嵌入·`{w=60}`·图注·缺图容错·`._docx_build` 清理·OPC 部件名）；D2 提交信息格式（PROJECT_RULES 6.1/6.2）；D3 项目记录（快照/工作日志）与仓库现状一致性；D4 对外文档（`输出文件/`）与实现一致性；D5 规范条款抽查（UTF-8 BOM·无 Tab·无第三方库与外链·甲方原件不入库·需求版本归档·9.8 变更表·md↔docx 同源）。 |
| `tests/stress-check.js` | `node tests/stress-check.js`（**长跑，默认 8 小时；需浏览器权限**） | S1 页面持续存活（时钟推进·无未捕获异常·无 console.error）；S2 JS 堆是否无界增长；S3 DOM/标签数/激活面板是否漂移；S4 跨班次时的班次名·统计·曲线固化·待补传队列变化；S5 每小时把 8 个页面轮巡一遍并切两次断连。环境变量：`DSH_STRESS_HOURS`（默认 8）、`DSH_STRESS_INTERVAL_MIN`（默认 10）、`DSH_STRESS_SIZE`（默认 3840x2160）、`DSH_STRESS_EDGE`。产物：`tests/._verify/stress-<时间戳>.csv / .log / -summary.json` 与首末截图。 |

> 上表 6.3～6.6、6.8～6.10 与 6.2 的**代码侧**已由 `contract-check.js` 覆盖，浏览器内的视觉与交互由 `browser-check.js` 覆盖。
>
> 脚本的**断言失败即待修缺陷**。当前结果（合计 137 通过 / 33 失败）：`contract-check` 31 通过 / 21 失败，`ui-check` 28 通过 / 6 失败（加 `--expose-gc` 为 29 / 6），`tools-check` 24 通过 / 0 失败，`browser-check` 18 通过 / 1 失败，`docs-check` 36 通过 / 5 失败。
>
> 失败项对应：`?source=upper` 取帧链缺陷与每秒 mock tick 覆盖报文、数据冻结不降级、当班统计为负、累计运行倒退、未闭环计数恒为 1、自检写死、用户输入未转义、docx 部件名用反斜杠（交付件与工具打包处都要改）、源码与样式表版本滞后、附录 2 声明 12 与实际 13、状态色与阈值重复写死、UI-04 字号不达标（指标名 52px、辅助说明 32～36px）、公告/待办空态缺失、无工单空态缺失、单任务五态不可达、提交信息不符 `类型: 说明` 格式（`review`、`代码审查`；两条说明超 30 字）、`当前状态快照.md` 的"最新提交"哈希过期、`PROJECT_RULES.md` 9.8 表重复登记 v1.8。修完对应源码/文档后重跑应转全绿；`contract-check` 的 K 段若失败，说明占位口径已变，需同步确认界面说明。
>
> 性能微基准（U5）实测：单次 tick + 10 个组件全量重绘约 **0.1 ms**（约 1 万次/秒），相对 1 秒刷新周期余量极大；连续 2000 次刷新在强制 GC 后堆增长 < 20 MB，未发现明显泄漏迹象。
>
> **长时间运行（整班次/7×24）用 `tests/stress-check.js` 单独跑**：默认 8 小时、每 10 分钟采样一次，判据与产物见上表；首轮冒烟（3.7 分钟）实测堆 9.5 MB、DOM 690 节点全程零漂移、无红色报错。

---

## 四、浏览器验证怎么做（无头 Edge + CDP）

`tests/browser-check.js` 不引入任何 npm 依赖，用本机已安装的 **Microsoft Edge** 无头模式 + **Chrome DevTools Protocol** 驱动真实页面：

| 环节 | 做法 |
| --- | --- |
| 启动浏览器 | `msedge --headless=new --disable-gpu --remote-debugging-port=18920 --user-data-dir=<临时目录> about:blank`，路径自动探测 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，可用环境变量 `MSEDGE_PATH` 覆盖 |
| 连接协议 | 从 `http://127.0.0.1:18920/json/list` 取页面 target 的 WebSocket 地址，用 **Node ≥22 内置的全局 `WebSocket`** 直连 CDP，自带极简客户端（`send/on`），不装 `puppeteer`/`playwright` |
| 断言方式 | `Runtime.evaluate` 在页面里取真实 DOM/计算样式（如 `getComputedStyle`、`scrollWidth`、`classList`），再用本脚本的 `check()` 判定 |
| 报错采集 | 同时开 `Runtime.enable` / `Log.enable`，把 `console.error`、未捕获异常、浏览器 error 日志收进 `consoleErrors`，对应"控制台无红色报错" |
| 页面截图 | 用 Edge 命令行 `--screenshot=<png> --window-size=3840,2160`（CDP 的 `captureScreenshot` 在 4K 下会挂住，已改为命令行并加 60 秒超时）；产物落在 **`tests/._verify/`**，该目录已被 `.gitignore` 忽略，不会进版本管理 |
| 环境变量 | `MSEDGE_PATH` 指定浏览器可执行文件；`DSH_EDGE_PORT` 指定调试端口（默认 18920） |

**权限要求（重要）：** Chromium 启动时必须创建 mojo 命名管道，受限沙箱（dsh 的 `workspace-write`）会以
`FATAL:mojo/platform_channel.cc: Check failed: 拒绝访问 (0x5)` 直接启动失败。因此本脚本要在**可创建命名管道的权限下**运行：

- 在 dsh 会话里：让助手以 `danger-full-access` 运行该命令（会弹一次批准）；
- 或在普通 PowerShell / 计划任务里直接 `node tests\browser-check.js`。

脚本在起不来时会整体记 `[SKIP]` 并退出码 0，不会误报成缺陷。

**新增一个浏览器场景**只需三步（参考 B2 段）：`await openPage('?参数')` → `await evaluate('页面内表达式')` → `check('断言名', 条件, '实测值')`。

**本脚本不覆盖**（仍需人工或后续补充）：动效/闪烁等主观项（UI-09/UI-18）、报警弹窗（UI-13，Demo 已声明未实现）、长时间稳定性与内存（需长时间观测）、截图与最新界面的逐像素比对（需先确定基准图管理方式）。

# 界面基准图（tests/screenshots-baseline）

> **用途：** 界面的**视觉回归基准**。改了 `src/components`、`src/styles`、`index.html` 之后，
> 用同一套捕获参数重新截图，与这里的基准逐像素比对，**不同像素占比 ≤ 5% 视为通过**。
>
> **维护人：代码项目成员**（本目录随代码走，不随 `输出文件\` 的交付截图自动同步）。

## 一、目录规则

| 项目 | 规则 |
| --- | --- |
| 命名 | 与 `src\assets\screenshots\` 完全一致：`NN-页面名.png`（序号 + 连字符 + 页面名） |
| 数量 | 10 张 = 8 个标签页 + 2 个特殊状态（曲线空态、上位机断连降级） |
| 尺寸 | **3840 × 2160**（设计基准 4K@30Hz；页内按 `#stage` 等比缩放） |
| 格式 | PNG（8 位、非隔行、RGB 或 RGBA）——`tests/screenshot-diff.js` 只识别这一种 |
| 初始来源 | 2026-09-18 的交付截图（与 `src\assets\screenshots\` 逐字节相同，Git 按内容去重不额外占用体积） |

## 二、捕获参数（必须固定，否则比对无意义）

| 序号 | 文件 | URL |
| --- | --- | --- |
| 01 | `01-设备状态-任务曲线.png` | `index.html`（默认首页） |
| 02 | `02-任务数据.png` | `index.html?tab=1` |
| 03 | `03-班次信息.png` | `index.html?tab=2` |
| 04 | `04-生产统计.png` | `index.html?tab=3` |
| 05 | `05-设备异常.png` | `index.html?tab=4` |
| 06 | `06-维保台账.png` | `index.html?tab=5` |
| 07 | `07-公告备注.png` | `index.html?tab=6` |
| 08 | `08-操作设置.png` | `index.html?tab=7` |
| 09 | `09-曲线初始空态.png` | `index.html?curve=none` |
| 10 | `10-上位机断连降级.png` | `index.html?link=off` |

捕获命令（无头 Edge，与 `tests/browser-check.js`、`tests/stress-check.js` 同一套工具链）：

```powershell
msedge --headless=new --disable-gpu --no-first-run --no-default-browser-check `
  --user-data-dir="$env:TEMP\shot" --window-size=3840,2160 `
  --screenshot="tests\screenshots-baseline\01-设备状态-任务曲线.png" `
  "file:///<项目路径>/index.html"
```

> 权限：Chromium 需要创建命名管道，受限沙箱（`workspace-write`）下会以
> `mojo platform_channel 拒绝访问` 启动失败；请在可创建命名管道的权限下运行。

## 三、固定画面的做法（关键）

看板含**实时时钟、随机游走数据、按任务固化的曲线**，直接两次截图必然不同，逐像素比对会永远失败。
所以基准图与候选图都必须在**同一固定画面**下拍摄，方法是在页面加载前注入两段脚本（CDP
`Page.addScriptToEvaluateOnNewDocument`）：

1. **固定时间**：把 `Date` 包装成"起点固定 + 单调递增"的版本（例如固定 `2026-09-18T10:00:00`，
   每次取时间只按注入后的虚拟节拍递增），使时钟、班次、统计都落在同一取值；
2. **固定随机**：用种子化伪随机替换 `Math.random`（例如 LCG，种子写死），使模拟数据与曲线可复现。

> 当前 10 张基准图是**未做固定处理的交付截图**：与今天的即时截图比对会因时钟/数值/曲线不同而
> 明显超过 5%。**首次按上表参数做一次确定性重拍后覆盖本目录**，基准才算正式生效；
> 在那之前，`screenshot-diff.js` 的结论只看"结构性差异"（布局、缺块、错位），不看动态数值。

## 四、比对与更新流程

| 步骤 | 操作 |
| --- | --- |
| 1 | 改完界面，按第二节同一参数重拍 10 张（建议拍到 `tests\screenshots-baseline\.candidate\`） |
| 2 | 运行 `node tests\screenshot-diff.js --candidate tests\screenshots-baseline\.candidate` |
| 3 | 全部 ≤ 5% → 通过；任一超过 5% → 人工看图确认是"预期改动"还是"回归缺陷" |
| 4 | 属预期改动 → 人工确认后**覆盖基准图**，并按 `PROJECT_RULES` 第六章提交：`样式: 更新界面基准图（设备状态页…）` |
| 5 | 属回归缺陷 → 不覆盖基准，先修界面 |

> 阈值固定为 **5%**（不同像素占比）；单通道容差 ±8（抗 PNG 编码与抗锯齿的微小抖动）。
> 改了阈值要同步改本文件与提交说明，避免"悄悄放宽标准"。

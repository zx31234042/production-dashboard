/* ==========================================================================
   界面文案与需求条款对照（tests/copy-check.js）
   作用：把需求清单里"规定了界面文案"的条款，与 `index.html` / 组件 / 数据源里的实际
         文案逐条对照，形成可执行的断言；未确认的映射先列为"待确认"，不参与断言。
   判据：status = 'confirmed' 的条目，其每条预期文案必须出现在 files 列出的任一文件里；
         status = 'pending' 的条目只打印，供人工确认映射后再升级为 confirmed。
   依赖：仅 Node 内置模块（源码级文本核对，不启浏览器）。
   运行：node tests/copy-check.js（--list 打印全部条目）
   退出码：0 = 已确认条目全部命中；1 = 有确认条目未命中（文案被改动或写错）。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LIST = process.argv.includes('--list');

/* ---------------- 对照表 ----------------
   条目字段：clause 需求条款 | note 需求原文摘要 | items 预期文案 | files 应出现的文件 | status
   ------------------------------------------------------------------------------------------ */
const MAP = [
  { clause: 'FR-2.1', note: '运行模式 5 种：待机、测试运行、正常停机、维保检修、故障锁定', status: 'confirmed',
    items: ['待机', '测试运行', '正常停机', '维保检修', '故障锁定'],
    files: ['src/components/DeviceStatusPanel.js', 'src/config/fieldMap.js'] },

  { clause: 'FR-2.5', note: '运行阶段 4 阶段：准备 / 运行 / 判定 / 完成', status: 'confirmed',
    items: ['准备', '运行', '判定', '完成'],
    files: ['src/services/mockData.js', 'src/services/mockUpperSource.js'] },

  { clause: 'FR-2.6', note: '联网状态：在线正常 / 离线断连 / 数据传输异常', status: 'confirmed',
    items: ['在线正常', '离线断连', '数据传输异常'],
    files: ['src/config/fieldMap.js', 'src/services/mockData.js', 'src/components/DeviceStatusPanel.js'] },

  { clause: 'FR-3.13', note: '单任务结果五态：待测试 / 测试中 / 合格 / 不合格 / 待复检', status: 'confirmed',
    items: ['待测试', '测试中', '合格', '不合格', '待复检'],
    files: ['index.html', 'src/services/mockData.js'] },

  { clause: 'FR-4.1-FR-4.15', note: '当班生产统计 15 项指标名', status: 'confirmed',
    items: ['计划测试总数', '实际开工总数', '未开工数量', '已完成测试数', '测试中数量', '待测试数量',
      '合格数', '不合格数', '复检数', '一次性合格率', '有效运行时长', '待机时长', '平均测试时长',
      '产能达成率', '设备稼动率'],
    files: ['index.html'] },

  { clause: 'FR-5.8-FR-5.11', note: '四类预防性预警名称', status: 'confirmed',
    items: ['参数阈值临近预警', '设备维保到期预警', '耗材更换预警', '工单超时预警'],
    files: ['src/services/mockData.js'] },

  { clause: 'FR-5.12', note: '异常闭环状态四态：未处理 / 处理中 / 已闭环 / 复检确认中', status: 'confirmed',
    items: ['未处理', '处理中', '已闭环', '复检确认中'],
    files: ['src/services/mockData.js'] },

  { clause: 'FR-5.13', note: '异常台账四列：发生时间 / 代码 / 故障简述 / 闭环状态', status: 'confirmed',
    items: ['发生时间', '代码', '故障简述', '闭环状态'],
    files: ['index.html'] },

  { clause: 'FR-6.7-FR-6.10', note: '检修记录四列：检修时间 / 检修内容 / 责任人 / 验收状态', status: 'confirmed',
    items: ['检修时间', '检修内容', '责任人', '验收状态'],
    files: ['index.html'] },

  { clause: 'FR-7.1-FR-7.4', note: '车间公告四类标签：生产调整 / 工艺变更 / 临时管控 / 车间公示', status: 'confirmed',
    items: ['生产调整', '工艺变更', '临时管控', '车间公示'],
    files: ['src/services/mockData.js', 'index.html'] },

  { clause: 'FR-7.5-FR-7.7', note: '测试工艺提示三类：测试要求 / 质量管控 / 操作注意', status: 'confirmed',
    items: ['测试要求', '质量管控', '操作注意'],
    files: ['src/services/mockData.js'] },

  { clause: 'FR-7.8-FR-7.10', note: '待办提醒三项：待复检任务 / 待维保作业 / 未闭环异常', status: 'confirmed',
    items: ['待复检任务', '待维保作业', '未闭环异常'],
    files: ['src/services/mockData.js'] },

  { clause: 'FR-8.1', note: '解锁状态文案：当前已锁定 / 已解锁', status: 'confirmed',
    items: ['当前已锁定', '已解锁'],
    files: ['index.html', 'src/components/SettingPanel.js'] },

  { clause: 'FR-8.3', note: '时间设置按钮：立即同步 NTP / 手工设置时间', status: 'confirmed',
    items: ['立即同步 NTP', '手工设置时间'],
    files: ['index.html'] },

  { clause: 'FR-8.5', note: '系统自检七项名称', status: 'confirmed',
    items: ['看板主机网络', 'PC 上位机连接', 'MES 接口连通性', 'MES 上报队列', '本地数据库', '磁盘空间', 'NTP 时间同步'],
    files: ['src/services/mockData.js'] },

  { clause: 'FR-9.1', note: '底部八个标签名称', status: 'confirmed',
    items: ['设备状态', '任务数据', '班次信息', '生产统计', '设备异常', '维保台账', '公告备注', '操作设置'],
    files: ['src/pages/Dashboard.js', 'index.html'] },

  { clause: 'UI-17', note: '页脚四要素标签：版本 / 最后刷新 / 上位机链路 / MES 链路', status: 'confirmed',
    items: ['版本', '最后刷新', '上位机链路', 'MES 链路'],
    files: ['index.html'] },

  { clause: 'UI-19', note: '曲线空态文案', status: 'confirmed',
    items: ['暂无已完成任务数据', '完成一次测试任务后自动绘制完整曲线'],
    files: ['index.html'] },

  { clause: 'FR-1.6-FR-1.9', note: '头部人员字段标签：班组 / 操作员 / 班组长', status: 'confirmed',
    items: ['班组', '操作员', '班组长'],
    files: ['index.html'] },

  { clause: 'FR-1.3-FR-1.4', note: '日期与星期只要求"显示取值"，不要求文字标签；此处按格式/取值集合判定', status: 'confirmed',
    items: ["pad(now.getMonth() + 1)", "pad(now.getDate())", "hdrDate", "'星期日', '星期一'"],
    files: ['src/services/mockData.js', 'index.html'] },

  { clause: 'FR-6.4-FR-6.6', note: '累计运行三项展示名（当日/本月/年度累计运行）；经确认为等价表述，数值单位由 h 与时钟格式体现', status: 'confirmed',
    items: ['当日累计运行', '本月累计运行', '年度累计运行'],
    files: ['index.html'] },

  /* 已确认需修改界面、但先登记到《审查报告》待改（登记后不改，故不参与断言） */
  { clause: 'FR-3.16', note: '设备参数次要区用词与需求不一致：界面"实际帧率/快门"，需求"实时帧率/相机增益/快门速度/相机水下深度"；已登记为《审查报告-2026-09-19》P3-20 待改',
    status: 'fix-pending', items: ['实时帧率', '快门速度'], files: ['index.html'] }
];

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failures.push({ name, detail }); console.log(`  [FAIL] ${name}${detail ? ' —— ' + detail : ''}`); }
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function main() {
  const confirmed = MAP.filter(m => m.status === 'confirmed');
  const pending = MAP.filter(m => m.status === 'fix-pending');
  console.log(`对照表条目：${MAP.length} 条（已确认断言 ${confirmed.length}、登记待改 ${pending.length}）\n`);

  console.log('=== 一、已确认条目的文案核对（源码级） ===');
  for (const m of confirmed) {
    const texts = m.files.map(f => ({ f, t: readText(f) }));
    const missing = m.items.filter(item => !texts.some(x => x.t.includes(item)));
    check(
      `${m.clause} 文案（${m.items.length} 项）`,
      missing.length === 0,
      missing.length ? `未找到：${missing.join('、')}（查了 ${m.files.join('、')}）` : `命中于 ${texts.filter(x => m.items.some(i => x.t.includes(i))).map(x => x.f).join('、')}`
    );
  }

  console.log('\n=== 二、已登记待改的条目（不参与断言，改完再升级为 confirmed） ===');
  for (const m of pending) {
    console.log(`  [!] ${m.clause}：${m.note}`);
    console.log(`      改完应出现：${m.items.join('、')}（文件：${m.files.join('、')}）`);
  }

  if (LIST) {
    console.log('\n=== 附：全部条目 ===');
    for (const m of MAP) console.log(`  ${m.status.padEnd(9)} ${m.clause.padEnd(14)} ${m.items.join('、')}`);
  }

  console.log('\n=== 汇总 ===');
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项；登记待改 ${pending.length} 条`);
  if (failures.length) {
    console.log('\n失败清单：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.name}${f.detail ? ' —— ' + f.detail : ''}`));
    process.exit(1);
  }
  process.exit(0);
}

try { main(); } catch (err) {
  console.error('\n脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
}

/* ==========================================================================
   组件：任务数据页（components/TaskPanel.js）
   需求：FR-3 工单信息、实时实测数据、测试进度与结果
         FR-3.5～3.8 测试标准阈值（设备参数，次要）；FR-3.16 设备参数次要展示
   ========================================================================== */
window.Components = window.Components || {};
window.Components.TaskPanel = (function () {
  'use strict';

  const { setText, setHTML, setStyle, $ } = window.Dom;

  /* 设备参数的允许偏差（用于"正常 / 临近 / 超标"判定） */
  const TOLERANCE = {
    depth:   { unit: 'm',   warn: 0.10, err: 0.20, digits: 2 },
    gain:    { unit: '',    warn: 0.15, err: 0.30, digits: 1 },
    fps:     { unit: 'fps', warn: 1,    err: 2,    digits: 0 },
    shutter: { unit: '',    warn: 5,    err: 10,   digits: 0 }
  };

  function render(state) {
    const t = state.task;

    /* 当前工单信息（IF-A 派工 / IF-D 转发的字段） */
    setHTML('tkOrderList', [
      ['工单编号', t.procOrderNo],
      ['产品型号', t.productCode],
      ['产品名称', t.productName],
      ['产品批次', t.batchNo],
      ['生产订单编号', t.orderNo],
      ['图号', t.drawingNo],
      ['计划测试数量', `${t.planQty} 件`],
      ['工序', '水下高速摄像检验（工序号 30）']
    ].map(([k, v]) => `<div class="kv-row"><span class="k">${k}</span><span class="v mono">${v}</span></div>`).join(''));

    /* 主要实测数据：航行器深度与航行速度（FR-3.9～3.11 / C-31、C-32） */
    setText('tkDepth', t.real.depth.toFixed(2));
    setText('tkSpeed', t.real.speed.toFixed(2));
    setText('tkVx', t.real.vx.toFixed(2));
    setText('tkVy', t.real.vy.toFixed(2));

    /* 设备参数与设定阈值：次要展示（FR-3.5～3.8、3.16）；相机设定深度无对应实测值 */
    const rows = [
      ['相机设定深度', t.std.depth,   null,           'depth',   'm'],
      ['设定帧率',     t.std.fps,     t.real.fps,     'fps',     'fps'],
      ['相机增益',     t.std.gain,    t.real.gain,    'gain',    ''],
      ['快门速度',     t.std.shutter, t.real.shutter, 'shutter', '']
    ];
    const tbody = $('tkCompareTable').querySelector('tbody');
    tbody.innerHTML = rows.map(([name, std, real, key, unit]) => {
      const tol = TOLERANCE[key];
      const stdTxt = `<td class="mono">${std.toFixed(tol.digits)}${unit ? ' ' + unit : ''}</td>`;
      if (real === null) {
        return `<tr><td>${name}</td>${stdTxt}<td class="muted">—</td><td class="muted">—</td><td class="muted">设备参数</td></tr>`;
      }
      const dev = real - std;
      const abs = Math.abs(dev);
      const lv = abs >= tol.err ? 'err' : (abs >= tol.warn ? 'warn' : 'ok');
      const lvText = lv === 'err' ? '超标' : (lv === 'warn' ? '临近' : '正常');
      const sign = dev > 0 ? '+' : '';
      return `<tr>
        <td>${name}</td>
        ${stdTxt}
        <td class="mono">${real.toFixed(tol.digits)}${unit ? ' ' + unit : ''}</td>
        <td class="mono ${lv}">${sign}${dev.toFixed(tol.digits)}</td>
        <td class="${lv}">${lvText}</td>
      </tr>`;
    }).join('');

    /* 测试实时进度 */
    const pct = t.progress * 100;
    setText('tkProgressPct', pct.toFixed(1) + '%');
    setStyle('tkProgressBar', 'width', pct.toFixed(1) + '%');
    setText('tkProgressText', `当前第 ${t.unitIndex} 件 · 当班已完成 ${state.stats.done} / ${state.stats.plan} 件`);

    /* 单任务测试结果（五态流转） */
    const colors = { '合格': '#00B050', '不合格': '#FF0000', '待复检': '#FFC000', '待测试': '#8FA9C4' };
    setText('tkResult', t.result);
    setStyle('tkResult', 'color', colors[t.result] || '#38A3E0');
    setText('tkResultNote', `上一件判定结果：${t.lastResult} · 节拍 ${window.MockData.CFG.cycleSec}s/件`);
    document.querySelectorAll('.flow-step').forEach(el =>
      el.classList.toggle('on', el.dataset.step === t.result));
  }

  return { render };
})();

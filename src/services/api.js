/* ==========================================================================
   真实接口占位（services/api.js）
   作用：后期接入真实数据时使用；当前 Demo 全部走 mockData.js，本文件不参与渲染
   对应需求（详见需求清单 V1.24 第 6 章）：
     - IF-A  MES → 本机   ：派工/物料/工艺信息下发（本机提供接口）
     - IF-B  本机 → MES   ：报告工/异常/关键参数，按附录 2 上传 12 个字段
     - IF-D  PC 上位机 → 本机：航行器深度、航行速度、设备参数等实时测量数据
   注意：接口地址、鉴权由 MES 方与上位机方提供（Q-21、Q-23 关闭后填入 CONFIG）
   ========================================================================== */
window.Api = (function () {
  'use strict';

  /* 配置项：联调时填写，不要写死在业务代码里（PROJECT_RULES 9.7） */
  const CONFIG = {
    enabled: false,        // 置为 true 后由 main.js 切换到真实数据源
    mesBaseUrl: '',        // 例：http://10.10.x.x:8080/mes
    mesToken: '',          // 鉴权令牌（按 MES 要求）
    upperBaseUrl: ''       // PC 上位机地址（IF-D）
  };

  /** IF-D：拉取一帧实时测量数据（上位机已整合 19 台相机结果，本机不做二次聚合） */
  async function fetchRealtime() {
    if (!CONFIG.enabled) return null;
    // TODO: 联调后实现，返回结构与 mockData.state 保持一致
    return null;
  }

  /** IF-A：接收 MES 派工信息（本机作为服务提供方，由 MES 调用，此处仅登记契约） */
  async function receiveDispatch() {
    if (!CONFIG.enabled) return null;
    return null;
  }

  /** IF-B：向 MES 上报数据（附录 2 的 12 个字段，含 uploadId 去重与失败补传） */
  async function uploadReport() {
    if (!CONFIG.enabled) return null;
    return null;
  }

  return { CONFIG, fetchRealtime, receiveDispatch, uploadReport };
})();

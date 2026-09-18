@echo off
REM ==========================================================================
REM 模拟上位机 · 启动脚本
REM 作用：先切换控制台为 UTF-8（避免中文日志乱码），再启动 Node 服务
REM 用法：双击本文件，或在本目录执行 start.cmd [参数]
REM       参数与 mock-upper.js 相同，例如： start.cmd --port 8801 --push http://127.0.0.1:9000/api/realtime
REM ==========================================================================
chcp 65001 >nul
cd /d "%~dp0"
node mock-upper.js %*
pause

@echo off
chcp 936 >nul
title 小鹅通已购课程下载工具
cd /d "%~dp0"
if not exist "node_modules\playwright-core" (
  echo 首次运行，正在安装依赖...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络或 npm 配置。
    pause
    exit /b 1
  )
)
echo 正在启动小鹅通已购课程下载工具...
node server.js
pause

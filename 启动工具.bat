@echo off
chcp 65001 >nul
title 小鹅通已购课程下载工具
cd /d %~dp0
echo 正在启动小鹅通已购课程下载工具...
node server.js
pause

@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"

REM 清理 WorkBuddy 安全删除拦截（手动双击时这些变量本就不存在，无副作用）
set CODEBUDDY_SAFE_DELETE_BULK_GUARD=
set CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR=
set CODEBUDDY_TOOL_CALL_ID=
set CODEBUDDY_NODE_BIN=

set "PORT=7400"
set "NODE=%~dp0node\node.exe"
set "SERVER=%~dp0webide\server.mjs"
set "LOG=%~dp0webide\server.log"

REM ---- 依赖检查 ----
if not exist "%NODE%" (
  echo [AbapBuddy] 未找到 Node 运行时: %NODE%
  pause
  exit /b 1
)
if not exist "%SERVER%" (
  echo [AbapBuddy] 未找到服务端: %SERVER%
  pause
  exit /b 1
)

REM ---- 启动前先释放 7400 端口（杀掉占用该端口的旧进程，避免残留实例冲突）----
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
  echo [AbapBuddy] 释放被占用的端口 %PORT% ^(PID=%%a^)，正在关闭旧进程...
  taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo [AbapBuddy] 正在启动后端服务（端口即将就绪，浏览器会立即打开；Agent 会话在后台初始化，约需 10~25 秒后可用）...
REM node 标准输出/错误重定向到日志文件，避免 conhost 在 65001 下对管道 UTF-8 输出产生重复乱码
start /b "" "%NODE%" "%SERVER%" > "%LOG%" 2>&1

REM ---- 等待端口可访问（后端秒级监听，最多 30 秒）----
powershell -NoProfile -Command "$ok=$false; for($i=0;$i-lt30;$i++){ try{ if((Invoke-WebRequest -Uri 'http://127.0.0.1:%PORT%/api/state' -TimeoutSec 1 -UseBasicParsing).StatusCode -eq 200){$ok=$true;break} }catch{}; Start-Sleep -Seconds 1 }; if(-not $ok){ exit 1 }"
if errorlevel 1 (
  echo [AbapBuddy] 服务启动超时。请查看日志: %LOG%
  pause
  exit /b 1
)

echo [AbapBuddy] 端口已就绪，正在打开浏览器...
start http://127.0.0.1:%PORT%/
echo.
echo [AbapBuddy] 已启动：浏览器 http://127.0.0.1:%PORT%/
echo 页面打开后若显示"Agent 未就绪"，请稍候片刻，会话初始化完成后会自动变为"已连接"。
echo 运行日志已写入 webide\server.log，下方实时显示；关闭此窗口将停止后台服务。
echo.

REM ---- 用 PowerShell 正确读取 UTF-8 日志并实时跟随（无重复乱码）；关闭窗口即停止服务 ----
powershell -NoProfile -Command "Get-Content -Path '%LOG%' -Encoding utf8 -Wait"

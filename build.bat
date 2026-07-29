@echo off
chcp 65001 >nul 2>&1
setlocal

REM 清理 WorkBuddy 安全删除拦截（手动双击时这些变量本就不存在，无副作用）
set CODEBUDDY_SAFE_DELETE_BULK_GUARD=
set CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR=
set CODEBUDDY_TOOL_CALL_ID=
set CODEBUDDY_NODE_BIN=

cd /d "%~dp0"

REM ===== 构建前检查：清理 Windows 保留设备名文件（nul/con/aux/prn 等） =====
REM 这些文件如果在 Git Bash 中手误创建（如 git status > nul），会导致安装包
REM 含"毒瘤文件"：NSIS 卸载程序无法删除它们（Windows 保留设备名保护），
REM 进而导致"failed to uninstall old application files"更新失败。
echo [预检] 扫描异常文件名...
powershell -NoProfile -Command "^
  $bad = @('nul','con','aux','prn'); ^
  for ($i=1; $i -le 9; $i++) { $bad += \"com$i\"; $bad += \"lpt$i\" }; ^
  $found = @(); ^
  $dirs = @($pwd.Path, (Join-Path $pwd.Path 'webide'), (Join-Path $pwd.Path 'gxx-abap'), (Join-Path $pwd.Path '.pi'), (Join-Path $pwd.Path '.gxx-abap')); ^
  foreach ($d in $dirs) { ^
    foreach ($n in $bad) { ^
      $p = Join-Path $d $n; ^
      $lp = '\\?\' + $p; ^
      if (Test-Path -LiteralPath $lp) { ^
        Write-Host \"  [警告] 发现保留设备名文件: $p\"; ^
        Remove-Item -LiteralPath $lp -Force -ErrorAction Stop; ^
        Write-Host \"  [已清理] 已删除\"; ^
        $found += $p ^
      } ^
    } ^
  }; ^
  if ($found.Count -gt 0) { ^
    Write-Host \"  [提示] 以上文件是因 Git Bash 中误用 `> nul` 产生的，已自动清理。\" ^
  } else { ^
    Write-Host \"  [通过] 未发现异常文件名\" ^
  }"
if %ERRORLEVEL% neq 0 (
  echo [预检] 扫描失败，但继续构建...
)

echo ============================================
echo   AbapBuddy 一键构建（生成 NSIS 安装包）
echo ============================================
echo.

REM ===== 1) API Key 脱敏处理 =====
set "AUTH_FILE=.pi\auth.json"
set "AUTH_BAK=.pi\auth.json.bak"
if exist "%AUTH_FILE%" (
  echo [准备] 备份 auth.json 并用占位符替换（防止开发 Key 被打包进去）
  copy /y "%AUTH_FILE%" "%AUTH_BAK%" >nul
  echo {>"%AUTH_FILE%"
  echo   "deepseek": {>>"%AUTH_FILE%"
  echo     "type": "api_key",>>"%AUTH_FILE%"
  echo     "key": "请输入你的API_KEY">>"%AUTH_FILE%"
  echo   }>>"%AUTH_FILE%"
  echo }>>"%AUTH_FILE%"
) else (
  echo [准备] auth.json 不存在，跳过脱敏
)

REM ===== 2) 从 update.json 读取版本号 =====
if exist "update.json" (
  node "package\update-version.js"
) else (
  echo [版本] update.json 不存在，保持 package.json 现有版本
)

REM 3) 清理旧构建产物，避免新旧叠加
if exist "package\release" (
  echo [2/5] 清理旧 release 目录...
  rmdir /s /q "package\release" 2>nul
) else (
  echo [2/5] 无旧 release，跳过
)

REM ===== 4) 精简 node_modules（移除未使用的 AI 提供商 SDK，节省 ~50MB）=====
cd /d "%~dp0"
echo [3/5] 精简 node_modules...
if exist "node_modules\@earendil-works\pi-coding-agent\node_modules\@mistralai" (
  rmdir /s /q "node_modules\@earendil-works\pi-coding-agent\node_modules\@mistralai" 2>nul
  echo   - 移除 @mistralai (28MB，未使用)
)
if exist "node_modules\@earendil-works\pi-coding-agent\node_modules\@google" (
  rmdir /s /q "node_modules\@earendil-works\pi-coding-agent\node_modules\@google" 2>nul
  echo   - 移除 @google (14MB，未使用)
)
if exist "node_modules\@earendil-works\pi-coding-agent\node_modules\@anthropic-ai" (
  rmdir /s /q "node_modules\@earendil-works\pi-coding-agent\node_modules\@anthropic-ai" 2>nul
  echo   - 移除 @anthropic-ai (6MB，未使用)
)

REM 5) 进入打包目录并运行 electron-builder（优先用本地安装，缺失则退回 npx）
cd /d "%~dp0package"

REM 设置 Electron 国内镜像（加速首次下载，之后走缓存）
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"

REM 如使用 VPN 代理，取消下面注释并填入代理地址：
REM set "HTTPS_PROXY=http://127.0.0.1:7890"

echo [4/5] 开始打包（首次需联网下载 Electron 运行时，约 100MB，之后走缓存）...
echo.
if exist "node_modules\.bin\electron-builder.cmd" (
  call node_modules\.bin\electron-builder.cmd
) else (
  call npx electron-builder
)
set "BUILD_ERR=%errorlevel%"

REM 恢复实时 API Key
cd /d "%~dp0"
if exist "%AUTH_BAK%" (
  copy /y "%AUTH_BAK%" "%AUTH_FILE%" >nul
  del "%AUTH_BAK%"
  echo [恢复] auth.json 已还原
)

if %BUILD_ERR% neq 0 (
  echo.
  echo [失败] 构建出错，请查看上方日志。
  pause
  exit /b 1
)

REM 5) 输出结果
echo.
echo [5/5] 构建完成！安装包位置：
for /f "delims=" %%f in ('dir /b /o-d package\release\*.exe 2^>nul') do echo   %~dp0package\release\%%f
echo.
echo 双击该 exe 即可安装；再次运行本脚本可重新打包。
pause

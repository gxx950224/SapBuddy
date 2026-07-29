@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

echo ============================================
echo   Upload to Alibaba Cloud OSS
echo ============================================
echo.

if not exist "package\release\AbapBuddy-setup.exe" (
  echo [ERROR] Cannot find package\release\AbapBuddy-setup.exe
  echo   Please run build.bat first
  pause
  exit /b 1
)
if not exist "update.json" (
  echo [ERROR] Cannot find update.json
  pause
  exit /b 1
)

echo Files to upload:
echo   package\release\AbapBuddy-setup.exe
echo   update.json
echo.

REM Load credentials from config file if exists
if exist "upload_oss.credentials" (
  for /f "usebackq delims=" %%a in ("upload_oss.credentials") do set "%%a"
)

set AK_ID=%1
set AK_SECRET=%2
if "%AK_ID%"=="" set AK_ID=%OSS_AK_ID%
if "%AK_SECRET%"=="" set AK_SECRET=%OSS_AK_SECRET%

if "%AK_ID%"=="" (
  echo [ERROR] Missing AccessKeyId
  echo   Usage: upload_oss.bat ^<AccessKeyId^> ^<AccessKeySecret^>
  echo   Or create upload_oss.credentials with:
  echo     OSS_AK_ID=your_access_key_id
  echo     OSS_AK_SECRET=your_access_key_secret
  pause
  exit /b 1
)

node "package\upload-oss.js" "%AK_ID%" "%AK_SECRET%" "%OSS_BUCKET%" "%OSS_REGION%"

if %errorlevel% neq 0 (
  echo [ERROR] Upload failed
) else (
  echo [OK] Upload complete
)
pause

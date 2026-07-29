@echo off
setlocal
set "NODE_PATH=%~dp0node_modules;%NODE_PATH%"
"%~dp0node\node.exe" "%~dp0gxx-abap\bin\gxx-abap.js" %*
endlocal

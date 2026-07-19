@echo off
setlocal EnableExtensions

cd /d "%~dp0"
set "ROOT=%CD%"
set "ADDON_DIR=%ROOT%\addons\godetx"
set "RUNTIME_OUT=%ADDON_DIR%\runtime"

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [GodotX] npm.cmd was not found in PATH.
  exit /b 1
)

set "NODE_BIN=%GODOTX_NODE_BIN%"
if not defined NODE_BIN set "NODE_BIN=%GODETX_NODE_BIN%"
if not defined NODE_BIN (
  for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NODE_BIN set "NODE_BIN=%%I"
)
if not defined NODE_BIN (
  echo [GodotX] node.exe was not found. Install Node.js or set GODOTX_NODE_BIN.
  exit /b 1
)
if not exist "%NODE_BIN%" (
  echo [GodotX] node.exe does not exist: %NODE_BIN%
  exit /b 1
)

set "NODE_INFO_FILE=%TEMP%\godetx-node-info-%RANDOM%-%RANDOM%.txt"
"%NODE_BIN%" -p "process.platform + ' ' + process.arch" > "%NODE_INFO_FILE%"
if errorlevel 1 (
  if exist "%NODE_INFO_FILE%" del /q "%NODE_INFO_FILE%"
  echo [GodotX] Could not inspect Node.js: %NODE_BIN%
  exit /b 1
)
set /p "NODE_INFO=" < "%NODE_INFO_FILE%"
del /q "%NODE_INFO_FILE%"
for /f "tokens=1,2" %%I in ("%NODE_INFO%") do (
  set "NODE_PLATFORM=%%I"
  set "NODE_ARCH=%%J"
)
if /i not "%NODE_PLATFORM%"=="win32" (
  echo [GodotX] This batch file packages Windows Node.js only. Detected: %NODE_PLATFORM%-%NODE_ARCH%
  exit /b 1
)
if not defined NODE_ARCH (
  echo [GodotX] Could not detect the Node.js architecture.
  exit /b 1
)

set "NODE_OUT=%ADDON_DIR%\bin\windows-%NODE_ARCH%"
for %%I in ("%NODE_BIN%") do set "NODE_HOME=%%~dpI"

echo [1/5] Building the TypeScript Runtime...
call npm.cmd run build
if errorlevel 1 goto :failed

echo [2/5] Preparing the bundled Runtime directory...
if exist "%RUNTIME_OUT%" rmdir /s /q "%RUNTIME_OUT%"
if exist "%RUNTIME_OUT%" (
  echo [GodotX] Could not replace the bundled Runtime directory. Disable the plugin and retry.
  goto :failed
)
mkdir "%RUNTIME_OUT%\dist\src" >nul 2>nul
if not exist "%NODE_OUT%" mkdir "%NODE_OUT%" >nul 2>nul
if errorlevel 1 goto :failed

copy /y "%ROOT%\package.json" "%RUNTIME_OUT%\package.json" >nul
copy /y "%ROOT%\package-lock.json" "%RUNTIME_OUT%\package-lock.json" >nul
robocopy "%ROOT%\runtime\dist\src" "%RUNTIME_OUT%\dist\src" /e /nfl /ndl /njh /njs /nc /ns >nul
if errorlevel 8 goto :failed

echo [3/5] Installing production dependencies...
call npm.cmd ci --prefix "%RUNTIME_OUT%" --omit=dev --ignore-scripts --no-audit --no-fund
if errorlevel 1 goto :failed
type nul > "%RUNTIME_OUT%\.gdignore"
type nul > "%ADDON_DIR%\bin\.gdignore"

echo [4/5] Ensuring Node.js %NODE_ARCH%...
if exist "%NODE_OUT%\node.exe" (
  "%NODE_OUT%\node.exe" -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)" >nul 2>nul
  if errorlevel 1 (
    copy /y "%NODE_BIN%" "%NODE_OUT%\node.exe" >nul
    if errorlevel 1 (
      echo [GodotX] The existing bundled node.exe is unavailable and could not be replaced.
      echo [GodotX] Disable the GodotX plugin, then run this package script again.
      goto :failed
    )
  ) else (
    echo [GodotX] Reusing the active bundled node.exe.
  )
) else (
  copy /y "%NODE_BIN%" "%NODE_OUT%\node.exe" >nul
  if errorlevel 1 goto :failed
)
if exist "%NODE_HOME%LICENSE" copy /y "%NODE_HOME%LICENSE" "%NODE_OUT%\NODE_LICENSE.txt" >nul
"%NODE_OUT%\node.exe" --version > "%NODE_OUT%\NODE_VERSION.txt"

echo [5/5] Verifying the bundled Runtime...
"%NODE_OUT%\node.exe" -e "import(require('node:url').pathToFileURL(process.argv[2]).href).then(function(){console.log('[GodotX] Bundled Runtime import OK')}).catch(function(error){console.error(error);process.exit(1)})" verify "%RUNTIME_OUT%\dist\src\server.js"
if errorlevel 1 goto :failed

echo.
echo [GodotX] Packaging completed.
echo [GodotX] Addon: %ADDON_DIR%
echo [GodotX] Node:  %NODE_OUT%\node.exe
echo [GodotX] Copy the addons\godetx directory to install the self-contained Windows plugin.
exit /b 0

:failed
echo.
echo [GodotX] Packaging failed.
exit /b 1

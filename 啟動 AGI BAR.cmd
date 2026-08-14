@echo off
setlocal enabledelayedexpansion
title AGI BAR - Local AI Gateway

rem ==========================================================
rem  AGI BAR startup script (plan section 11)
rem
rem  KEEP THIS FILE PURE ASCII.
rem
rem  cmd.exe decodes a batch file using the *console* codepage
rem  (950 on zh-TW Windows), not UTF-8. Non-ASCII text saved as
rem  UTF-8 is therefore misread as Big5, and "chcp 65001" halfway
rem  through shifts the parser's byte offsets so that later lines
rem  get chopped into fragments ('ple.json" (' and similar).
rem
rem  All localized (Chinese) output is printed by Node instead,
rem  see server/index.mjs. scripts/lint.mjs enforces ASCII here.
rem ==========================================================

cd /d "%~dp0"

rem UTF-8 console, so Node's Chinese output renders correctly.
rem Safe only because this file itself contains no non-ASCII bytes.
chcp 65001 >nul 2>nul

echo.
echo   ==========================================================
echo    AGI BAR - Local AI Gateway Management System
echo   ==========================================================
echo.

rem ---- 1. Prefer the bundled runtime (portable ZIP) ----
set "NODE_EXE="
if exist "runtime\node.exe" (
    set "NODE_EXE=%~dp0runtime\node.exe"
    echo   [1/3] Using bundled Node runtime
) else (
    where node >nul 2>nul
    if errorlevel 1 (
        echo   [ERROR] Node.js not found. / ^(Node.js^)
        echo.
        echo   Choose one:
        echo     A. Install Node.js 24 LTS or newer from https://nodejs.org/
        echo     B. Put node.exe into the runtime\ folder next to this script
        echo.
        pause
        exit /b 1
    )
    set "NODE_EXE=node"
    echo   [1/3] Using system Node.js
)

rem ---- 2. Version check (node:sqlite needs 23.4+, we require 24 LTS) ----
rem
rem  The "usebackq" form with quotes ONLY around the executable is the one
rem  that survives both a bare "node" on PATH and a full path containing
rem  spaces (e.g. D:\AGI BAR\runtime\node.exe). Adding a second quoted
rem  argument makes cmd mis-split the command line, so we use "-v" (which
rem  needs no argument) and strip the leading "v".
set "NODE_VER="
for /f "usebackq tokens=1 delims=." %%v in (`"!NODE_EXE!" -v`) do set "NODE_VER=%%v"
set "NODE_MAJOR=!NODE_VER:v=!"

if not defined NODE_MAJOR (
    echo   [ERROR] Could not determine the Node.js version.
    echo           Tried: "!NODE_EXE!" -p "process.versions.node"
    echo.
    pause
    exit /b 1
)

if !NODE_MAJOR! LSS 24 (
    echo   [ERROR] Node.js v!NODE_MAJOR! is too old. v24 or newer is required.
    echo           Download: https://nodejs.org/
    echo.
    pause
    exit /b 1
)
echo   [2/3] Node version OK ^(v!NODE_MAJOR!^)

rem ---- 3. Start. config\config.json is created by the server on first run. ----
echo   [3/3] Starting gateway...
echo.

"!NODE_EXE!" "server\index.mjs"
set "EXITCODE=!ERRORLEVEL!"

echo.
if not "!EXITCODE!"=="0" (
    echo   Service stopped with error code !EXITCODE!.
    echo   See data\logs\ for details.
) else (
    echo   Service stopped normally.
)
echo.
pause
endlocal

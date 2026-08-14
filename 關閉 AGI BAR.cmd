@echo off
setlocal enabledelayedexpansion
title AGI BAR - Stop

rem ==========================================================
rem  AGI BAR stop script (plan section 11)
rem
rem  KEEP THIS FILE PURE ASCII -- see the note in the start
rem  script for why. scripts/lint.mjs enforces it.
rem
rem  Shutdown strategy:
rem    1. Create data\shutdown.request. Windows has no real
rem       signals -- taskkill sends WM_CLOSE, which a console
rem       app without a window never receives, so it would
rem       always end up force-killed, skipping the database
rem       close and the final log flush. The server polls for
rem       this file and shuts down cleanly when it appears.
rem    2. Only if that does not finish in time do we fall back
rem       to taskkill /f.
rem
rem  We stop only our own PID (data\agibar.pid), so other
rem  node.exe processes on the machine are left alone.
rem ==========================================================

cd /d "%~dp0"
chcp 65001 >nul 2>nul

echo.
echo   Stopping AGI BAR...
echo.

if not exist "data\agibar.pid" (
    echo   data\agibar.pid not found - the service does not appear to be running.
    goto :done
)

set "AGIBAR_PID="
set /p AGIBAR_PID=<"data\agibar.pid"

if not defined AGIBAR_PID (
    echo   data\agibar.pid is empty. Removing it.
    del /q "data\agibar.pid" >nul 2>nul
    goto :done
)

tasklist /fi "PID eq !AGIBAR_PID!" 2>nul | find "!AGIBAR_PID!" >nul
if errorlevel 1 (
    echo   PID !AGIBAR_PID! is not running. Cleaning up stale pid file.
    del /q "data\agibar.pid" >nul 2>nul
    goto :done
)

rem ---- 1. Ask the server to shut down cleanly ----
echo   Requesting graceful shutdown of PID !AGIBAR_PID! ...
echo stop > "data\shutdown.request"

rem Wait up to ~15s. "ping" instead of "timeout" because timeout aborts with
rem "Input redirection is not supported" whenever stdin is redirected.
set "WAITED=0"
:waitloop
ping -n 2 127.0.0.1 >nul 2>nul
set /a WAITED+=1
tasklist /fi "PID eq !AGIBAR_PID!" 2>nul | find "!AGIBAR_PID!" >nul
if errorlevel 1 goto :stopped
if !WAITED! LSS 15 goto :waitloop

rem ---- 2. Fallback: force ----
echo   Graceful shutdown timed out. Forcing PID !AGIBAR_PID! to exit.
taskkill /pid !AGIBAR_PID! /t /f >nul 2>nul
ping -n 2 127.0.0.1 >nul 2>nul
goto :cleanup

:stopped
echo   Service shut down cleanly.

:cleanup
del /q "data\agibar.pid" >nul 2>nul
del /q "data\shutdown.request" >nul 2>nul
echo   AGI BAR stopped.

:done
echo.
pause
endlocal

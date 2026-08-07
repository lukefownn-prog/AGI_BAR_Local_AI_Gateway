@echo off
chcp 65001 >nul
setlocal
title AGI BAR - 停止服務

rem ==========================================================
rem  AGI BAR 停止腳本（規畫書 11）
rem  依 data\agibar.pid 精準結束本服務，不會誤殺其他 Node 程序。
rem ==========================================================

cd /d "%~dp0"

echo.
echo   停止 AGI BAR 服務...
echo.

if not exist "data\agibar.pid" (
    echo   找不到 data\agibar.pid，服務可能未在執行中。
    echo.
    pause
    exit /b 0
)

set /p AGIBAR_PID=<"data\agibar.pid"

tasklist /fi "PID eq %AGIBAR_PID%" 2>nul | find "%AGIBAR_PID%" >nul
if errorlevel 1 (
    echo   PID %AGIBAR_PID% 已不存在，清除殘留的 pid 檔。
    del /q "data\agibar.pid" >nul 2>nul
    echo.
    pause
    exit /b 0
)

taskkill /pid %AGIBAR_PID% /t >nul 2>nul
timeout /t 3 /nobreak >nul

tasklist /fi "PID eq %AGIBAR_PID%" 2>nul | find "%AGIBAR_PID%" >nul
if not errorlevel 1 (
    echo   正常關閉逾時，強制結束 PID %AGIBAR_PID%
    taskkill /pid %AGIBAR_PID% /t /f >nul 2>nul
)

del /q "data\agibar.pid" >nul 2>nul
echo   AGI BAR 已停止。
echo.
pause
endlocal

@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title AGI BAR - Local AI Gateway

rem ==========================================================
rem  AGI BAR 啟動腳本（規畫書 11）
rem  刻意使用透明的批次檔而非自製未簽章 EXE，方便管理員與 EDR 稽核。
rem ==========================================================

cd /d "%~dp0"

echo.
echo   ==========================================================
echo    AGI BAR - Local AI Gateway Management System
echo   ==========================================================
echo.

rem ---- 1. 優先使用內附 runtime\node.exe（Portable ZIP）----
set "NODE_EXE="
if exist "runtime\node.exe" (
    set "NODE_EXE=%~dp0runtime\node.exe"
    echo   [1/3] 使用內附 Node Runtime
) else (
    where node >nul 2>nul
    if errorlevel 1 (
        echo   [錯誤] 找不到 Node.js。
        echo.
        echo   請擇一處理：
        echo     A. 下載 Node.js 22 以上的 Windows 版，安裝後重新執行本腳本
        echo     B. 將 node.exe 放入本資料夾的 runtime\ 目錄
        echo.
        pause
        exit /b 1
    )
    set "NODE_EXE=node"
    echo   [1/3] 使用系統已安裝的 Node.js
)

rem ---- 2. 版本檢查（node:sqlite 免旗標需 Node 23.4+，實務上要求 24 LTS）----
for /f "tokens=1 delims=." %%v in ('"%NODE_EXE%" -p "process.versions.node"') do set "NODE_MAJOR=%%v"
if !NODE_MAJOR! LSS 24 (
    echo   [錯誤] Node.js 版本過舊（偵測到 v!NODE_MAJOR!），需要 v24 以上。
    echo.
    pause
    exit /b 1
)
echo   [2/3] Node 版本檢查通過 ^(v!NODE_MAJOR!^)

rem ---- 3. 首次啟動：由範例產生本機設定檔 ----
if not exist "config\config.json" (
    if exist "config\config.example.json" (
        copy /y "config\config.example.json" "config\config.json" >nul
        echo   [提示] 已由範例建立 config\config.json
    )
)

echo   [3/3] 啟動 Gateway 服務...
echo.

"%NODE_EXE%" "server\index.mjs"
set "EXITCODE=%ERRORLEVEL%"

echo.
if not "%EXITCODE%"=="0" (
    echo   服務異常結束，代碼：%EXITCODE%
    echo   詳細訊息請查看 data\logs\ 目錄下的紀錄檔。
) else (
    echo   服務已正常停止。
)
echo.
pause
endlocal

@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Муха выбрала быть счастливой

if not exist ".venv\Scripts\python.exe" (
  echo No local venv yet. Run install.bat first.
  echo.
  pause
  exit /b 1
)

if not exist "data\brains.npz" (
  echo data\brains.npz is missing. The flies have no brains.
  echo.
  pause
  exit /b 1
)

set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1

echo.
echo  Leave this window open. Close it to stop.
echo  First launch compiles the brain — give it a minute, then the browser opens.
echo.

".venv\Scripts\python.exe" launch.py
if errorlevel 1 (
  echo.
  echo Server exited with an error.
  pause
)

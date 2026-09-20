@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Install — Муха выбрала быть счастливой

echo.
echo  Local virtualenv in .venv, packages from requirements.txt
echo.

py -3 --version >nul 2>&1
if not errorlevel 1 (
  set "PY=py -3"
) else (
  python --version >nul 2>&1
  if errorlevel 1 (
    echo Python 3 was not found.
    echo Install it from https://www.python.org/downloads/
    echo and tick "Add python.exe to PATH".
    echo.
    pause
    exit /b 1
  )
  set "PY=python"
)

echo Using: %PY%
%PY% --version
echo.

if exist ".venv\Scripts\python.exe" (
  echo .venv already exists — installing into it.
) else (
  echo Creating .venv ...
  %PY% -m venv .venv
  if errorlevel 1 (
    echo Failed to create .venv
    pause
    exit /b 1
  )
)

echo Upgrading pip ...
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 (
  echo pip upgrade failed.
  pause
  exit /b 1
)

echo Installing requirements ...
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
  echo pip install failed.
  pause
  exit /b 1
)

if not exist "data\brains.npz" (
  echo.
  echo  WARNING: data\brains.npz is missing.
  echo  The game will not start without it.
)

echo.
echo  Done. Double-click start.bat whenever you want to open the bar.
echo.
pause

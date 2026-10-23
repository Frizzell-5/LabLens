@echo off
rem Double-click to open LabLens in your browser. Close this window to stop it.
cd /d "%~dp0"
set PY=python
where py >nul 2>nul && set PY=py
start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:8765/app.html"
echo LabLens is running at http://127.0.0.1:8765/app.html
echo Close this window to stop it.
%PY% -m http.server 8765 --bind 127.0.0.1
pause

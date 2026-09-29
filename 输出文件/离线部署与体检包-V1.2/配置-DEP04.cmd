@echo off
rem ==========================================================================
rem  DEP-04 unattended-settings configurator (NEEDS ADMIN).
rem  ASCII only + CRLF: see the read-only launcher next to it for why (technical debt E49).
rem  It locates the single .ps1 next to this file and runs it with
rem  -ConfigureDep04. It DOES change system settings: sleep/hibernate/monitor
rem  timeouts -> never, screensaver -> off, update auto-reboot -> disabled,
rem  wireless power saving -> max performance. Nothing else is touched.
rem ==========================================================================
setlocal
set "SCRIPT="
for %%f in ("%~dp0*.ps1") do set "SCRIPT=%%~ff"
if not defined SCRIPT (
  echo [ERROR] no .ps1 script found next to this file.
  pause
  exit /b 1
)
net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo Applying DEP-04 unattended settings. This changes system settings.
echo Script : %SCRIPT%
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -ConfigureDep04
echo.
pause
endlocal

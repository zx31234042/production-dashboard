@echo off
rem ==========================================================================
rem  Field gates runner: browser-class + visual gates, ONE BY ONE.
rem  ASCII only + CRLF (technical debt E49). No admin needed, no internet.
rem
rem  WHY THIS EXISTS: typing "node tests\xxx.js" by hand is error-prone
rem  (on 2026-09-29 the field typed "test\" instead of "tests\" and got
rem  "Cannot find module"). And running the FULL run-all on a machine
rem  NOTE: stress-check here runs its DEFAULT 2-minute smoke. The AC-07
rem  "continuous >= 7 days" soak is a different entry: see the 7-day
rem  launcher next to this file, which passes --hours 168 --soak-ledger.
rem
rem  without git prints a false "authority number has drifted" alarm
rem  (technical debt E55) -- so we run the scripts one by one here.
rem ==========================================================================
setlocal
set "SCRIPT="
for %%f in ("%~dp0*.ps1") do set "SCRIPT=%%~ff"
if not defined SCRIPT (
  echo [ERROR] no .ps1 script found next to this file.
  pause
  exit /b 1
)
echo Running field gates one by one: capture-baseline, screenshot-diff,
echo browser-check, overlap-check, stress-check (the last one takes ~2 min).
echo For the 7-day soak required by AC-07 use the 7-day launcher instead:
echo Script : %SCRIPT%
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -RunFieldGates
echo.
pause
endlocal

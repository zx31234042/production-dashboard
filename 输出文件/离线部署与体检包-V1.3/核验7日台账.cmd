@echo off
rem ==========================================================================
rem  Soak-ledger verifier -- the five AC-07 criteria, printed one by one.
rem
rem  WHAT IT RUNS:  node tests\stress-check.js --verify-soak <ledger.jsonl>
rem    Double-click with no argument  -> the newest ledger under
rem                                      tests\._verify\soak\*.jsonl
rem    Drag a ledger .jsonl onto this file -> verify that one
rem
rem  The five criteria: 1 continuous >= 7 days with no restart, 2 no crash,
rem  3 no memory leak, 4 sampling continuity, 5 evidential value - that last
rem  one fails on a compressed clock, so only a real-clock ledger counts.
rem
rem  ASCII only + CRLF (technical debt E49). No admin needed, no internet.
rem  NOTE: --verify-soak deliberately prints NO standard summary line - it is
rem  not a gate round. Do not read it as "all gates green".
rem ==========================================================================
setlocal
set "SCRIPT="
for %%f in ("%~dp0*.ps1") do set "SCRIPT=%%~ff"
if not defined SCRIPT (
  echo [ERROR] no .ps1 script found next to this file.
  echo         Copy the whole package folder and retry.
  pause
  exit /b 1
)
echo Soak ledger verification - the five AC-07 criteria, one by one.
echo Double-click = newest ledger under tests\._verify\soak\;
echo or drag a ledger .jsonl onto this file to verify that one.
echo Script : %SCRIPT%
if not "%~1"=="" echo Ledger : %~1
echo.
if "%~1"=="" goto :autopick
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -VerifySoak -SoakLedger "%~1"
goto :done
:autopick
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -VerifySoak
:done
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" echo Result : all five AC-07 criteria passed. Send back the ledger
if "%RC%"=="0" echo          .jsonl and the verification report.
if "%RC%"=="1" echo Result : at least one AC-07 criterion FAILED - see the lines
if "%RC%"=="1" echo          above; each names the offending item.
if "%RC%"=="2" echo Result : usage or environment error - see the message above.
pause
endlocal & exit /b %RC%

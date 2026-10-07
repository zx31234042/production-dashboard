@echo off
rem ==========================================================================
rem  7-day soak launcher -- AC-07: "runs continuously for >= 7 days".
rem
rem  WHAT IT RUNS:  node tests\stress-check.js --hours 168 --soak-ledger <jsonl>
rem    --hours 168   = 7 x 24 h  -> the ONLY soak setting that can serve as
rem                    AC-07 evidence. A compressed clock (--day-seconds) may
rem                    NOT: it is marked clockCompressed and criterion 5 fails.
rem    --soak-ledger = the evidence-day ledger, JSONL, one fsync per line.
rem                    It is the only proof that the 7 days really ran back to
rem                    back. Keep it and send it back with the other outputs.
rem
rem  ASCII only + CRLF (technical debt E49). No admin needed, no internet.
rem  The work happens in the .ps1 next to this file, mode -RunSoak7Day: it
rem  locates the portable Node in "._node" and the repository, prints the site
rem  rules and the ledger path, then runs the soak in the foreground.
rem
rem  SITE RULES - each one can void the whole run:
rem   1. run the DEP-04 configurator first: sleep / hibernate / screen-off =
rem      never, and "do not auto-reboot after updates" is set.
rem   2. do NOT shut down, do NOT lock the screen, do NOT let Windows reboot.
rem   3. an interruption or a reboot VOIDS the whole run: the ledger keeps a
rem      row with runComplete=false. Start a NEW run with a NEW ledger path.
rem   4. keep the repository frozen while soaking: the ledger meta row stores
rem      the sha256 of tests\stress-check.js.
rem   5. when it finishes, double-click the ledger verifier next to this file:
rem      it prints the five AC-07 criteria one by one.
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
echo 7-day soak - AC-07: continuous ^>= 7 days, that is --hours 168.
echo This window must stay open for the whole run; progress is printed here
echo and also logged under the repository tests\._verify folder.
echo The machine must NOT sleep, hibernate, lock, reboot or be shut down.
echo Run the DEP-04 configurator first, and keep the repository frozen.
echo Script : %SCRIPT%
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -RunSoak7Day %*
set "RC=%ERRORLEVEL%"
echo.
echo Done. Exit code %RC% - send back the ledger .jsonl and the reports.
pause
endlocal & exit /b %RC%

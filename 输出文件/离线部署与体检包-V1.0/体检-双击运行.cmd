@echo off
rem ==========================================================================
rem  Offline deployment env-check launcher.
rem  WHY THIS FILE IS STRICTLY ASCII:
rem  cmd.exe reads a .cmd using the OEM code page (936 on zh-CN). A UTF-8
rem  (no BOM) file containing Chinese is therefore mis-decoded, and the
rem  mis-decoded bytes can even split a line -- measured on 2026-09-28:
rem  "set SCRIPT=%~dp0<chinese>.ps1" then "if not exist" reported NOTFOUND.
rem  So: no Chinese literal here. The PowerShell script next to this file is
rem  located by wildcard instead (exactly one .ps1 ships in this folder).
rem  Line endings are CRLF; keep them that way.
rem  (Background: technical debt E49 in the project's roadmap.)
rem ==========================================================================
setlocal
set "SCRIPT="
for %%f in ("%~dp0*.ps1") do set "SCRIPT=%%~ff"
if not defined SCRIPT (
  echo [ERROR] no .ps1 script found next to this file.
  echo         Copy the whole folder, then double-click this file again.
  pause
  exit /b 1
)
echo Running deployment environment check... (no admin needed; the system itself is not changed)
echo Script : %SCRIPT%
echo Report : written into the "._env-report" subfolder next to this script
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
echo.
echo Done. Please send back the report .txt from the "._env-report" subfolder.
pause
endlocal

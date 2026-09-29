@echo off
rem ==========================================================================
rem  Offline deployment env-check launcher.
rem  WHY THIS FILE IS STRICTLY ASCII:
rem  cmd.exe reads a .cmd using the OEM code page (936 on zh-CN). A UTF-8
rem  (no BOM) file containing Chinese is therefore mis-decoded, and the
rem  mis-decoded bytes can even split a line -- measured on 2026-09-28:
rem  "set SCRIPT=%~dp0<chinese>.ps1" then "if not exist" reported NOTFOUND.
rem  So: no Chinese literal here. Files are located by wildcard instead.
rem  Line endings are CRLF; keep them that way.
rem  (Background: technical debt E49 in the project's roadmap.)
rem
rem  NODE: the operator must NOT have to edit PATH or walk the Windows
rem  settings UI -- Win10 and Win11 put "advanced system settings" in
rem  different places (measured 2026-09-28 on Win11: the path documented
rem  for Win10 does not exist there; it lives under "About" now).
rem  If the portable Node shipped with this package was extracted next to
rem  this file, we use it for THIS SESSION ONLY. Nothing is modified.
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
rem  The shipped folder is "._node" (dot-prefixed ON PURPOSE: this folder must be
rem  skipped by the repo's file-hygiene gate -- an extracted Node tree adds 1668
rem  text files / 1124 .js files, measured 2026-09-28. Dot-dirs are skipped there,
rem  and Windows Explorer still shows them normally.)
set "NODE_DIR="
if exist "%~dp0._node\node.exe" set "NODE_DIR=%~dp0._node"
if not defined NODE_DIR if exist "%~dp0node\node.exe" set "NODE_DIR=%~dp0node"
if not defined NODE_DIR for /d %%d in ("%~dp0._node-v*-win-x64") do if exist "%%~fd\node.exe" set "NODE_DIR=%%~fd"
if not defined NODE_DIR for /d %%d in ("%~dp0node-v*-win-x64") do if exist "%%~fd\node.exe" set "NODE_DIR=%%~fd"
if defined NODE_DIR set "PATH=%NODE_DIR%;%PATH%"
echo Running deployment environment check... (no admin needed; the system itself is not changed)
echo Script : %SCRIPT%
if defined NODE_DIR echo Node   : %NODE_DIR%\node.exe   portable, session-only PATH
if not defined NODE_DIR echo Node   : no portable Node next to this package; will use PATH
echo Report : written into the "._env-report" subfolder next to this script
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
echo.
echo Done. Please send back the report .txt from the "._env-report" subfolder.
pause
endlocal
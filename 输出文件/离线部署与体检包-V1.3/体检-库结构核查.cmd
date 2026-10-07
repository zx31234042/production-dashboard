@echo off
rem ==========================================================================
rem  Read-only database schema check - technical debt E71 / E73.
rem  It looks at every board database file it can find and reports whether the
rem  columns that were added later to existing tables are present or missing.
rem
rem  WHY THIS FILE IS STRICTLY ASCII:
rem  cmd.exe reads a .cmd using the OEM code page, 936 on zh-CN. A UTF-8 file
rem  without BOM that contains Chinese is therefore mis-decoded, and the
rem  mis-decoded bytes can even split a line - measured on 2026-09-28:
rem  a "set SCRIPT=%~dp0<chinese>.ps1" line followed by "if not exist" reported
rem  NOTFOUND. So: ASCII only here, and no round brackets in any echo text,
rem  because cmd may read an unescaped bracket as the start of a block.
rem  The script file name below is ASCII on purpose; only this launcher and the
rem  guide carry a Chinese display name. Line endings are CRLF; keep them so.
rem  Background: technical debt E49 in the project roadmap.
rem
rem  NODE: uses the portable Node shipped next to this file, folder "._node",
rem  for THIS SESSION ONLY. PATH and the system are not modified.
rem
rem  SAFE: the check opens every database read-only. The only file it writes is
rem  its own report .txt inside the "._env-report" subfolder.
rem
rem  USAGE: double-click, or drag a folder onto this file, or run:
rem     the .cmd sitting next to db-schema-check.js  "D:\path\to\dashboard-app"
rem  It checks COLUMNS and INDEXES separately - they are NOT the same
rem  severity: a missing column breaks writing, a missing index only makes
rem  one query scan the whole table.
rem
rem  Exit code: 0 = no missing columns and no missing index;
rem             1 = at least one database misses a COLUMN - start the
rem                 dashboard service once, then re-check and it must be 0;
rem             2 = usage or environment error;
rem             4 = columns are complete, only the INDEX face differs
rem                 (correctness is fine - performance only).
rem ==========================================================================
setlocal
set "NODE_EXE="
if exist "%~dp0._node\node.exe" set "NODE_EXE=%~dp0._node\node.exe"
if not defined NODE_EXE if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"
if not defined NODE_EXE for /d %%d in ("%~dp0._node-v*-win-x64") do if exist "%%~fd\node.exe" set "NODE_EXE=%%~fd\node.exe"
if not defined NODE_EXE for /d %%d in ("%~dp0node-v*-win-x64") do if exist "%%~fd\node.exe" set "NODE_EXE=%%~fd\node.exe"
if not defined NODE_EXE where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE goto :nonode
set "SCRIPT=%~dp0db-schema-check.js"
if not exist "%SCRIPT%" goto :noscript
echo Database schema check - READ ONLY. No system change; the database files
echo are opened read-only and are never modified.
echo.
echo Node   : %NODE_EXE%
echo Script : %SCRIPT%
if "%~1"=="" echo Target : auto-detect - this folder, its parent, Desktop,
if "%~1"=="" echo          Documents, and the first-level folders of each drive
if not "%~1"=="" echo Target : %*
echo Report : the "._env-report" subfolder next to this script
echo.
"%NODE_EXE%" "%SCRIPT%" %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" echo Result : OK - no database is missing the checked columns.
if "%RC%"=="1" echo Result : some database is missing COLUMNS. Start the dashboard
if "%RC%"=="1" echo          service once on that machine, then run this check
if "%RC%"=="1" echo          again and the column face must report 0.
if "%RC%"=="2" echo Result : usage or environment error - see the message above.
if "%RC%"=="4" echo Result : columns OK - only INDEX differences were found.
if "%RC%"=="4" echo          A missing index does NOT affect correctness; it only
if "%RC%"=="4" echo          makes one range query scan the whole table.
echo.
echo Done. Please send back the report .txt from the "._env-report" subfolder.
pause
endlocal & exit /b %RC%

:nonode
echo [ERROR] no node.exe found: neither the portable "._node" folder next to
echo         this file, nor a "node" on PATH.
echo         Copy the whole package folder, including "._node", and retry.
pause
exit /b 2

:noscript
echo [ERROR] db-schema-check.js is missing next to this file.
echo         Copy the whole package folder and retry.
pause
exit /b 2

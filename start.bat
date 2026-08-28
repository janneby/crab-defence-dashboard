@echo off
rem Crab Defence Dashboard launcher (Windows) — uses electron.cmd shim, never bare node.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install || (echo npm install failed & pause & exit /b 1)
)
call node_modules\.bin\electron.cmd .

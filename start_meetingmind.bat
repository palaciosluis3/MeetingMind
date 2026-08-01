@echo off
rem Compatibility entry point. The real launcher is LaunchMeetingMind.vbs,
rem which runs the backend hidden (pythonw) so no terminal is shown.
rem Launch the .vbs directly to avoid even this window's brief flash.
start "" wscript.exe "%~dp0LaunchMeetingMind.vbs"
exit /b

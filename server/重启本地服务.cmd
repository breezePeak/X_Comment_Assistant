@echo off
powershell.exe -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -Command Restart-Service XCommentAssistant'"

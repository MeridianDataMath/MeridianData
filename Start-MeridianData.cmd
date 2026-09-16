@echo off
title MeridianData
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-MeridianData.ps1" %*

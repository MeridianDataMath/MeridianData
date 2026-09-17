@echo off
title MeridianDataHub
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-MeridianData.ps1" %*

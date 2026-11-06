@echo off
rem Values remain quoted data; no nested cmd /c command string contains paths.
"%CTL_SMOKE_NODE%" smoke.mjs "%CTL_SMOKE_VERSION%" %CTL_SMOKE_MODE_FLAG%
exit /b %errorlevel%

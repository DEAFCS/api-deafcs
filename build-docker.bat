@echo off
setlocal

cd /d "%~dp0"

echo Building ghcr.io/deafcs/api:latest ...
docker build -t ghcr.io/deafcs/api:latest .
if errorlevel 1 (
    echo.
    echo Build FAILED.
    exit /b 1
)

echo.
echo Build OK: ghcr.io/deafcs/api:latest

echo.
echo Pushing ghcr.io/deafcs/api:latest ...
docker push ghcr.io/deafcs/api:latest
if errorlevel 1 (
    echo.
    echo Push FAILED.
    exit /b 1
)

echo.
echo Push OK: ghcr.io/deafcs/api:latest

endlocal

$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '../..'))
docker info --format '{{.ServerVersion}}'
if ($LASTEXITCODE -ne 0) { throw 'Запустите Docker Desktop с Linux containers и повторите команду.' }
if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
$demoEnv = Get-Content -LiteralPath '.env' -Raw
if ($demoEnv -match '(?m)^MAX_MODE=real' -or $demoEnv -match '(?m)^APP_ENV=(production|staging)') { throw 'demo-up предназначен только для mock demo. Используйте инструкцию production.' }
docker compose --profile demo up --build -d
if ($LASTEXITCODE -ne 0) { throw 'Ошибка Docker Compose' }
docker compose wait migrate seed
if ($LASTEXITCODE -ne 0) { throw 'Ошибка миграции или seed. Выполните docker compose logs migrate seed.' }
Write-Host 'Готово: http://localhost:8080 — выберите демо-роль на экране входа.'
Write-Host 'Остановка с сохранением данных: docker compose down'
